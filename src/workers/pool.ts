/**
 * The worker pool: spawns and adopts workers, deals files out in batches,
 * steals work between queues, recycles fat workers and restarts crashed
 * ones. The governor's tick is its clock.
 */

import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

import { guard, warm } from "../constants.ts"
import { cache } from "../files/cache.ts"
import { files } from "../files/discovery.ts"
import { Governor } from "../system/governor.ts"
import { machine, ram } from "../system/resources.ts"
import { format } from "../ui/format.ts"
import type { Reporter } from "../ui/reporter.ts"
import { text } from "../ui/terminal.ts"
import { daemon } from "./daemon.ts"
import { connect } from "./ipc.ts"
import { slot, totals } from "./state.ts"

/** The worker pool. */
export class Pool {
    /** One slot per thread. */
    readonly workers: Workers.Slot[]
    /** The safeguard. */
    readonly governor: Governor
    /** Counts accumulated over the run. */
    readonly totals: Workers.Totals = totals()
    /** Resolves once the warm workers left by the last run have been probed. */
    readonly adoption: Promise<void>
    /** Resolves when every file has been accounted for. */
    readonly finished: Promise<void>
    /** Per-worker heap, MB; grows when a worker dies of it. */
    heap: number

    /** The project root. */
    private readonly cwd: string
    /** The parsed command line. */
    private readonly options: Cli.Options
    /** Colors. */
    private readonly c: Ui.Palette
    /** Directory the workers' sockets live in. */
    private readonly sockets: string
    /** What a worker must have been built from to be adopted. */
    private readonly epoch: string
    /** How the pool was sized. */
    private readonly plan: System.Plan
    /** The live view, once there is one. */
    private reporter: Reporter | null = null
    /** The first batch of every worker; from there each worker sizes its own. */
    private batch = 1
    /**
     * Files from a batch that killed a worker. They are retried one at a
     * time, so the crash can be pinned on a single file instead of blaming
     * the whole batch.
     */
    private readonly suspects = new Set<string>()
    /** A file that killed a worker must not wander the pool forever. */
    private readonly attempts = new Map<string, number>()
    /** Set once the run is over or interrupted; nothing is dispatched after. */
    private stopped = false
    /**
     * While warming, the pool has no files yet: a ready worker waits instead of
     * declaring itself done, and an empty pool is not a finished one.
     */
    private warming = true
    /** When a worker was last spawned. */
    private spawned = 0
    /** Set once the pool has been filled: from then on spawns are staggered. */
    private filled = false
    /** When a worker was last marked for recycling. */
    private recycled = 0
    /** Warm workers found at start, connected and greeted, waiting for a job. */
    private readonly warm: Workers.Warm[] = []
    /** How many workers to run; lowered when the heap cannot grow any more. */
    private target: number
    /** Governor ticks seen. */
    private samples = 0
    /** Active workers summed over the ticks. */
    private sum = 0
    /** Settles `finished`. */
    private resolve: () => void = () => {}

    /** Builds the slots and the governor and starts probing warm workers. */
    constructor({ cwd, options, palette, sockets, epoch, plan }: Workers.PoolConfig) {
        this.cwd = cwd
        this.options = options
        this.c = palette
        this.sockets = sockets
        this.epoch = epoch
        this.plan = plan
        this.target = plan.size
        // CE_HEAP_MB forces the per-worker heap. Meant for reproducing memory
        // failures on a machine that would not otherwise hit them.
        this.heap = Number.parseInt(process.env.CE_HEAP_MB ?? "", 10) || plan.heap
        this.workers = Array.from({ length: plan.threads }, (_unused, index) => slot(index))
        this.governor = new Governor({
            max: plan.threads,
            base: plan.size,
            cpuLimit: plan.cpuLimit,
            memoryLimit: plan.memoryLimit,
            enabled: options.safeguard,
            active: () => this.active(),
            settling: () => this.warming || this.workers.some((worker) => worker.state === "starting" || worker.state === "waiting"),
            share: () => this.totals.rss / ram,
        })
        this.finished = new Promise((resolve) => {
            this.resolve = resolve
        })
        this.adoption = this.adopt()
    }

    /* ---------------------------------------------------------------- */
    /* Lifecycle                                                         */
    /* ---------------------------------------------------------------- */

    /** Start sampling and filling the pool while discovery is still running. */
    start(): void {
        // The governor's tick is also the pool's clock: it re-balances after
        // every sample, which is what un-stalls the pool when the safeguard had
        // stopped every worker.
        this.governor.start(() => this.tick())
        this.balance()
    }

    /** Deal the files out across `shards` workers. */
    assign(list: string[], shards: number): void {
        this.batch = Math.max(1, Math.min(8, Math.ceil(list.length / shards / 10)))

        files.shard(list, shards).forEach((queue, index) => {
            this.workers[index].queue = queue
            this.workers[index].assigned = queue.length
        })
    }

    /** Print problems through the live view from now on. */
    attach(reporter: Reporter): void {
        this.reporter = reporter
    }

    /** Warm-up is over: the queues are full, go. */
    begin(): void {
        this.warming = false
        this.governor.settle()

        for (const worker of this.workers) {
            if (worker.state === "waiting") {
                this.dispatch(worker)
            }
        }

        // Nothing could be spawned while the queues were empty; fill the pool now
        // rather than on the governor's next tick.
        this.balance()
        this.check()
    }

    /** Nothing to lint after all: let every worker go. */
    async shutdown(): Promise<void> {
        this.warming = false
        this.governor.stop()
        await this.adoption
        this.kill()
    }

    /** Ctrl-C: tear everything down at once. */
    interrupt(): void {
        this.stopped = true
        this.governor.stop()
        this.reporter?.stop()
        this.kill()
    }

    /** Warm workers found and not yet handed a job; meaningful once `adoption` settled. */
    warmed(): number {
        return this.warm.length
    }

    /** Workers busy on average over the run. */
    average(): number {
        return this.samples > 0 ? this.sum / this.samples : this.plan.threads
    }

    /** Fold the workers' cache files into the shared one. */
    merge(): number {
        return this.options.cache ? cache.merge(this.cwd) : 0
    }

    /** The governor's tick: bookkeeping, then balance. */
    private tick(): void {
        this.samples += 1
        this.sum += this.active()

        if (this.governor.holding) {
            this.totals.held += guard.interval
        }

        if (process.env.CE_DEBUG === "1") {
            const histogram: Record<string, number> = {}

            for (const worker of this.workers) {
                histogram[worker.state] = (histogram[worker.state] ?? 0) + 1
            }

            process.stderr.write(`[pool] limit=${this.governor.limit} active=${this.active()} live=${this.workers.filter((w) => w.child).length} pending=${this.pending()} ${JSON.stringify(histogram)}\n`)
        }

        this.balance()
    }

    /** Print above the live block, or to stdout before there is one. */
    private print(s: string): void {
        if (this.reporter) {
            this.reporter.print(s)
        } else {
            process.stdout.write(`${s}\n`)
        }
    }

    /** Workers busy or starting. */
    private active(): number {
        return this.workers.filter((worker) => worker.state === "busy" || worker.state === "starting").length
    }

    /** Files queued or in flight. */
    private pending(): number {
        return this.workers.reduce((sum, worker) => sum + worker.queue.length + worker.flight.length, 0)
    }

    /* ---------------------------------------------------------------- */
    /* Warm workers                                                      */
    /* ---------------------------------------------------------------- */

    /**
     * Runs alongside discovery. A stale worker is told to leave, a busy one
     * (another run is using it) is left alone, a dead one's files are swept.
     */
    private async adopt(): Promise<void> {
        const trace = (socketPath: string, verdict: string): void => {
            if (process.env.CE_DEBUG === "1") {
                process.stderr.write(`[adopt] ${path.basename(socketPath)} ${verdict}\n`)
            }
        }

        await Promise.all(daemon.list(this.sockets).map(async (socketPath) => {
            const started = Date.now()

            try {
                const found = await connect<Workers.Request>(socketPath, warm.probe)

                if (found.hello.type !== "hello") {
                    found.socket.destroy()
                    trace(socketPath, "busy with another run")

                    return
                }

                // Stale, or started with a smaller heap than this run wants — a
                // survivor of a run that was probing for memory failures.
                if (found.hello.epoch !== this.epoch || found.hello.heap < this.heap) {
                    found.io.send({ type: "shutdown" })
                    found.socket.end()
                    fs.rmSync(daemon.stderr(socketPath), { force: true })
                    trace(socketPath, `stale: epoch ${found.hello.epoch} vs ${this.epoch}, heap ${found.hello.heap} vs ${this.heap}`)

                    return
                }

                this.warm.push(found as Workers.Warm)
                trace(socketPath, `adopted in ${Date.now() - started}ms (shard ${found.hello.shard})`)
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)

                trace(socketPath, `skipped after ${Date.now() - started}ms: ${reason}`)

                // Only a socket nobody listens on is a leftover of a dead worker.
                // A connection that was accepted but not answered in time is a
                // live worker that is busy — collecting the garbage of the run it
                // just finished, most likely — and deleting its socket would
                // orphan it: alive, holding gigabytes, and never adopted again.
                if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED" || (error as NodeJS.ErrnoException).code === "ENOENT") {
                    daemon.forget(socketPath)
                }
            }
        }))
    }

    /** Let the unused warm workers go back to sleep. */
    private release(): void {
        for (const found of this.warm.splice(0)) {
            found.io.send({ type: "release" })
            found.socket.end()
        }
    }

    /* ---------------------------------------------------------------- */
    /* Letting workers go                                                */
    /* ---------------------------------------------------------------- */

    /** Remove a worker's socket and stderr files. */
    private forget(link: Workers.Link): void {
        daemon.forget(daemon.socket(this.sockets, link.token))
    }

    /**
     * Let a worker go. A warm one goes back to sleep the moment its socket
     * closes; a one-shot one exits. Sending the release first lets a warm
     * worker finish what is in flight cleanly.
     */
    private retire(worker: Workers.Slot): void {
        const link = worker.child

        if (!link) {
            return
        }

        worker.child = null
        link.send({ type: link.persistent ? "release" : "shutdown" })
        link.socket?.end()

        if (!link.persistent) {
            this.forget(link)
        }
    }

    /** Get rid of a worker for good, warm or not: it is too fat to keep. */
    private discard(worker: Workers.Slot): void {
        const link = worker.child

        if (!link) {
            return
        }

        worker.child = null
        link.send({ type: "shutdown" })
        link.socket?.end()
        link.kill("SIGTERM")
        this.forget(link)
    }

    /** Tear every worker down at once. */
    private kill(): void {
        for (const worker of this.workers) {
            const link = worker.child

            worker.child = null

            if (!link) {
                continue
            }

            if (link.persistent) {
                link.socket?.destroy()
            } else {
                link.kill("SIGKILL")
                this.forget(link)
            }
        }

        this.release()
    }

    /** The run is over: retire everyone and settle `finished`. */
    private finish(): void {
        if (this.stopped) {
            return
        }

        this.stopped = true
        this.governor.stop()

        for (const worker of this.workers) {
            this.retire(worker)

            // A slot that never ran stays "spare" in the final frame — calling it
            // "done" would imply it did work it never got.
            worker.state = worker.started ? "done" : "cold"
            worker.current = ""
        }

        this.release()
        setTimeout(() => this.kill(), 2000).unref()
        this.resolve()
    }

    /** Finish once nothing is queued or in flight. */
    private check(): void {
        if (!this.stopped && !this.warming && this.pending() === 0) {
            this.finish()
        }
    }

    /* ---------------------------------------------------------------- */
    /* Handing out work                                                  */
    /* ---------------------------------------------------------------- */

    /**
     * Take work from the longest foreign queue. From stopped and parked
     * workers we take even the last file — otherwise it would sit there forever.
     */
    private steal(worker: Workers.Slot): boolean {
        let donor: Workers.Slot | null = null

        for (const candidate of this.workers) {
            if (candidate === worker || candidate.queue.length === 0) {
                continue
            }

            const idle = candidate.state === "cold" || candidate.state === "parked"

            if (!idle && candidate.queue.length < 2) {
                continue
            }

            if (!donor || candidate.queue.length > donor.queue.length) {
                donor = candidate
            }
        }

        if (!donor) {
            return false
        }

        const idle = donor.state === "cold" || donor.state === "parked"
        const take = idle ? donor.queue.length : Math.max(1, Math.floor(donor.queue.length / 2))
        const stolen = donor.queue.splice(donor.queue.length - take, take)

        donor.assigned -= stolen.length
        donor.reassigned += stolen.length
        worker.queue.push(...stolen)
        worker.assigned += stolen.length
        worker.stolen += stolen.length
        this.totals.rebalanced += stolen.length

        return true
    }

    /** Give a worker its next batch, or park, retire or recycle it. */
    private dispatch(worker: Workers.Slot): void {
        if (this.stopped) {
            return
        }

        // A worker torn down for recycling can still deliver messages that were
        // already in the IPC pipe when it was killed. There is nothing to give it;
        // balance() brings it back with its queue intact.
        if (!worker.child) {
            return
        }

        // Recycling happens here, between batches, so nothing is in flight and no
        // file is charged a crash attempt. The queue stays; balance() restarts it.
        if (worker.recycle) {
            this.discard(worker)
            worker.recycle = false
            worker.recycled += 1
            worker.rss = 0
            worker.state = "cold"
            worker.current = ""
            this.totals.recycled += 1

            return
        }

        // The safeguard caps how many workers may run at once, and while it is
        // holding for memory nobody gets work at all.
        if (this.governor.holding || this.active() > this.governor.limit) {
            worker.state = "parked"
            worker.current = ""
            this.totals.parked += 1
            this.check()

            return
        }

        if (worker.queue.length === 0 && !this.steal(worker)) {
            if (this.warming) {
                worker.state = "waiting"
                worker.current = ""

                return
            }

            worker.state = "done"
            worker.current = ""
            this.retire(worker)
            this.check()

            return
        }

        if (worker.batch === 0) {
            worker.batch = this.batch
        }

        // A suspect goes alone, so a second crash names the file.
        const take = this.suspects.has(worker.queue[0]) ? 1 : worker.batch
        const batch = worker.queue.splice(0, take)

        worker.flight = [...batch]
        worker.count = batch.length
        worker.state = "busy"
        worker.since = Date.now()
        worker.child.send({ type: "batch", files: batch })
    }

    /** Size the next batch from how long the last one took. */
    private adapt(worker: Workers.Slot, count: number): void {
        const elapsed = Math.max(1, Date.now() - worker.since)
        const wanted = Math.floor(guard.batch.target / (elapsed / count))

        worker.batch = Math.max(1, Math.min(guard.batch.max, wanted, worker.batch * guard.batch.growth))
    }

    /* ---------------------------------------------------------------- */
    /* Results                                                           */
    /* ---------------------------------------------------------------- */

    /** Account for one file's outcome and print its problems. */
    private result(worker: Workers.Slot, message: Workers.Report): void {
        const { c, cwd, options, totals } = this

        worker.done += 1
        worker.flight = worker.flight.filter((file) => file !== message.file)
        this.suspects.delete(message.file)

        if (message.failure) {
            worker.errors += 1
            totals.errors += 1
            totals.failures.push({ file: path.relative(cwd, message.file), error: message.failure })
            this.print(`\n${c.underline(c.bold(path.relative(cwd, message.file)))}\n  ${c.red("lint failed")}  ${c.dim(message.failure)}`)

            return
        }

        const result = message.result

        if (!result) {
            if (message.ignored) {
                totals.ignored += 1
            }

            return
        }

        if (result.fixedLines > 0) {
            worker.fixed += 1
            worker.lines += result.fixedLines
            totals.fixed += 1
            totals.lines += result.fixedLines
        }

        worker.errors += result.errorCount
        worker.warnings += result.warningCount
        totals.errors += result.errorCount
        totals.warnings += result.warningCount
        totals.fixableErrors += result.fixableErrorCount
        totals.fixableWarnings += result.fixableWarningCount

        const visible = options.quiet ? result.errorCount : result.errorCount + result.warningCount

        if (visible === 0) {
            return
        }

        totals.problematic += 1

        const block = format(result, { cwd, palette: c, quiet: options.quiet, headless: options.headless })

        if (block) {
            this.print(`\n${block}`)
        }
    }

    /**
     * Return orphaned files to the pool. A file that has already killed a
     * worker `guard.attempts` times on its own is not retried — it would take
     * down the whole pool one worker at a time; we mark it unchecked instead.
     * A crash under a batch blames nobody yet: the batch is retried one file
     * at a time until the culprit crashes alone.
     */
    private requeue(worker: Workers.Slot): void {
        const orphans: string[] = []
        const alone = worker.flight.length === 1

        // Only the in-flight files actually went through the crash.
        for (const file of worker.flight) {
            this.suspects.add(file)

            const attempt = alone ? (this.attempts.get(file) ?? 0) + 1 : this.attempts.get(file) ?? 0

            this.attempts.set(file, attempt)

            if (attempt >= guard.attempts) {
                this.totals.failures.push({
                    file: path.relative(this.cwd, file),
                    error: `crashed the worker ${attempt} times in a row — file left unchecked (worker heap: ${this.heap} MB)`,
                })
                // Count it as processed, otherwise progress never reaches the end.
                worker.done += 1
                worker.errors += 1
                continue
            }

            orphans.push(file)
        }

        orphans.push(...worker.queue)
        worker.flight = []
        worker.queue = []

        if (orphans.length === 0) {
            return
        }

        worker.assigned -= orphans.length
        worker.reassigned += orphans.length

        const targets = this.workers.filter((candidate) => candidate !== worker && candidate.state !== "done")

        if (targets.length === 0) {
            // Nobody to hand them to — keep them; balance() will respawn this worker.
            worker.queue = orphans
            worker.assigned += orphans.length
            worker.reassigned -= orphans.length

            return
        }

        this.totals.rebalanced += orphans.length

        orphans.forEach((file, offset) => {
            const target = targets[offset % targets.length]

            target.queue.push(file)
            target.assigned += 1
            target.stolen += 1
        })
    }

    /** Route a worker's message. */
    private receive(worker: Workers.Slot, message: Workers.Reply): void {
        switch (message.type) {
            case "ready":
                this.dispatch(worker)
                break
            case "start":
                worker.current = path.relative(this.cwd, message.file)
                    + (message.batch > 1 ? ` ${this.c.dim(`+${message.batch - 1}`)}` : "")
                break
            case "result":
                this.result(worker, message)
                break
            case "idle":
                this.adapt(worker, worker.count)
                this.dispatch(worker)
                break
            case "fatal":
                this.totals.failures.push({ file: `worker #${worker.index + 1}`, error: message.error })
                break
            default:
                break
        }
    }

    /** The last 4000 bytes of a worker's stderr. */
    private tail(link: Workers.Link): string {
        try {
            return fs.readFileSync(daemon.stderr(daemon.socket(this.sockets, link.token)), "utf8").slice(-4000)
        } catch {
            return ""
        }
    }

    /** The socket closed under us: the worker died, or never came up. */
    private lost(worker: Workers.Slot, link: Workers.Link): void {
        // Not ours any more — we let it go on purpose.
        if (worker.child !== link) {
            return
        }

        worker.child = null
        worker.current = ""

        const stderr = this.tail(link)

        this.forget(link)

        if (this.stopped) {
            return
        }

        // Died on its own — hand the files back, worker goes cold.
        worker.state = "cold"

        // V8 aborts the process when it cannot grow the heap. Respawning into
        // the same limit just repeats the crash, so the limit has to move.
        const oom = stderr.includes("heap out of memory")

        if (oom) {
            const c = this.c

            this.totals.oom += 1

            if (this.heap < guard.heap.max) {
                this.heap = Math.min(guard.heap.max, Math.round(this.heap * guard.heap.bump))
                this.print(` ${c.yellow("out of memory:")} ${c.dim(`worker #${worker.index + 1} hit its ${Math.round(this.heap / guard.heap.bump)} MB heap — restarting the pool at ${this.heap} MB`)}`)
            } else if (this.target > 1) {
                // Already at the maximum heap: the only lever left is concurrency.
                this.target -= 1
                this.governor.cap(this.target)
                this.print(` ${c.yellow("out of memory:")} ${c.dim(`worker #${worker.index + 1} died at the ${this.heap} MB ceiling — down to ${text.plural(this.target, "worker")}`)}`)
            }
        }

        if (worker.flight.length > 0 || worker.queue.length > 0) {
            this.totals.crashes.push(`worker #${worker.index + 1}: ${oom ? "out of memory" : "connection lost"}`)
            this.requeue(worker)
        }

        this.check()
    }

    /* ---------------------------------------------------------------- */
    /* Starting workers                                                  */
    /* ---------------------------------------------------------------- */

    /** Messages sent before the socket is up are queued. */
    private link(worker: Workers.Slot, { pid, token, persistent, proc }: Workers.LinkInit): Workers.Link {
        const pending: Workers.Request[] = []
        let io: Workers.Framed<Workers.Reply, Workers.Request> | null = null

        const self: Workers.Link = {
            pid,
            token,
            persistent,
            proc,
            socket: null,
            send: (message) => {
                if (io) {
                    io.send(message)
                } else {
                    pending.push(message)
                }
            },
            kill: (signal) => {
                try {
                    process.kill(pid, signal)
                } catch {
                    // Already gone.
                }
            },
            attach: (socket: net.Socket, framed) => {
                self.socket = socket
                io = framed
                io.on((message) => this.receive(worker, message))
                socket.on("error", () => {
                    // The close that follows is what matters.
                })
                socket.on("close", () => this.lost(worker, self))

                for (const message of pending.splice(0)) {
                    io.send(message)
                }
            },
        }

        return self
    }

    /** Give a slot a process: an adopted warm worker if there is one, else a fresh one. */
    private spawn(worker: Workers.Slot): void {
        const { cwd, options, plan } = this

        worker.state = "starting"
        worker.started = true
        worker.mark = worker.done
        this.spawned = Date.now()

        const cacheLocation = options.cache ? cache.worker(cwd, worker.index) : undefined

        // A fresh worker starts from a copy of the shared cache. A recycled one
        // keeps the file it already has — it holds this run's results too.
        if (cacheLocation && !fs.existsSync(cacheLocation)) {
            try {
                fs.copyFileSync(cache.shared(cwd), cacheLocation)
            } catch {
                // No shared cache yet — the worker starts cold and writes one.
            }
        }

        const job: Workers.Request = {
            type: "job",
            options: {
                cwd,
                fix: options.fix,
                cache: options.cache,
                cacheLocation,
                cacheStrategy: options.cacheStrategy,
                idleBudget: plan.idleBudget,
                shard: worker.index,
            },
        }

        // A warm worker first: it already has everything loaded. Preferably the
        // one that served this slot last time, and failing that one whose own
        // slot is not still waiting to be filled.
        const cold = (index: number): boolean =>
            this.workers.some((other) => other.state === "cold" && !other.child && other.index === index)
        const preferred = [
            this.warm.findIndex((candidate) => candidate.hello.shard === worker.index),
            this.warm.findIndex((candidate) => !cold(candidate.hello.shard)),
            0,
        ]
        const chosen = preferred.find((index) => index !== -1) ?? 0
        const found = this.warm.length > 0 ? this.warm.splice(chosen, 1)[0] : null

        if (found) {
            this.totals.adopted += 1
            worker.child = this.link(worker, { pid: found.hello.pid, token: found.hello.token, persistent: true, proc: null })
            worker.child.attach(found.socket, found.io)
            worker.child.send(job)

            return
        }

        const token = crypto.randomUUID()
        const socketPath = daemon.socket(this.sockets, token)
        // Worker stderr goes to a file, not the terminal: a dying worker prints
        // pages of V8 GC noise, and inheriting it shreds the live view. The
        // file is what tells an out-of-memory death from any other.
        const stderr = fs.openSync(daemon.stderr(socketPath), "w")
        // Only the slots the budget normally runs stay warm; a spare slot the
        // governor opened for a while is not worth a gigabyte of idle heap.
        const persistent = options.daemon && worker.index < plan.size

        const execArgv = [`--max-old-space-size=${this.heap}`]

        if (persistent) {
            // Lets an idle worker hand the job's garbage back to the machine.
            execArgv.push("--expose-gc")
        }

        const proc = childProcess.spawn(process.execPath, [...execArgv, daemon.entry], {
            cwd,
            detached: persistent,
            env: {
                ...process.env,
                CE_WORKER: "1",
                CE_TOKEN: token,
                CE_SOCKET: socketPath,
                CE_EPOCH: this.epoch,
                CE_HEAP: String(this.heap),
                CE_PERSIST: persistent ? "1" : "0",
            },
            stdio: ["ignore", "ignore", stderr],
        })

        fs.closeSync(stderr)
        proc.on("error", () => {
            // Never started: the connect below times out and reports it.
        })

        if (persistent) {
            proc.unref()
        }

        const self = this.link(worker, { pid: proc.pid ?? 0, token, persistent, proc })

        worker.child = self
        self.send(job)

        connect<Workers.Request>(socketPath, warm.connect)
            .then(({ socket, io }) => {
                if (worker.child !== self) {
                    // Given up on meanwhile (kill): don't leave it hanging.
                    socket.destroy()

                    return
                }

                self.attach(socket, io)
            })
            .catch(() => {
                this.lost(worker, self)
            })
    }

    /* ---------------------------------------------------------------- */
    /* Memory                                                            */
    /* ---------------------------------------------------------------- */

    /**
     * A worker past its share of the memory budget is marked for recycling.
     * Under system-wide pressure the biggest one goes first, whatever its size:
     * shrinking the pool would only make the survivors grow faster.
     */
    private trim(): void {
        const { totals, governor, plan } = this
        let ours = 0

        for (const worker of this.workers) {
            worker.rss = worker.child ? machine.rss(worker.child.pid) : 0
            ours += worker.rss
        }

        totals.rss = ours
        totals.peakRss = Math.max(totals.peakRss, ours)
        totals.peakMemory = Math.max(totals.peakMemory, governor.memory)

        if (this.reporter) {
            this.reporter.rss = ours
        }

        if (!this.options.safeguard || plan.rssBudget <= 0 || Date.now() - this.recycled < guard.recycle.cooldown) {
            return
        }

        // Restarting a worker that has barely begun throws away its warm-up for
        // nothing — it has not had time to grow.
        const eligible = this.workers.filter((worker) =>
            worker.child && !worker.recycle && worker.done - worker.mark >= guard.recycle.min)

        if (eligible.length === 0) {
            return
        }

        const fattest = eligible.reduce((worst, worker) => (worker.rss > worst.rss ? worker : worst))

        // Over its own share of the budget: recycle regardless of the machine.
        if (fattest.rss > plan.rssBudget) {
            fattest.recycle = true
            this.recycled = Date.now()

            return
        }

        // Otherwise only when the machine is tight AND the memory is largely
        // ours. Recycling cannot free what another process is holding, and doing
        // it anyway just costs throughput.
        if (governor.pressure && ours > plan.budget * 0.5) {
            fattest.recycle = true
            this.recycled = Date.now()
        }
    }

    /** Kill a parked worker to hand its memory back to the machine. */
    private shed(): void {
        const victim = this.workers.find((worker) => worker.state === "parked" && worker.child)

        if (!victim) {
            return
        }

        this.discard(victim)
        victim.state = "cold"
        this.totals.killed += 1
    }

    /**
     * Keep exactly as many live workers as the safeguard allows. Spawn one at
     * a time and no faster than `guard.spawn`, so start-up itself doesn't
     * become the load spike.
     */
    private balance(): void {
        if (this.stopped) {
            return
        }

        this.trim()

        const { governor } = this

        if (governor.holding) {
            // Waiting for the machine to give memory back — and handing ours over
            // while we wait, since idle workers are pure ballast at this point.
            this.shed()

            return
        }

        // A parked worker is only worth killing outright once recycling the busy
        // ones has failed to relieve the pressure.
        if (governor.pressure && governor.tight >= guard.ram.windows) {
            this.shed()
        }

        // Waking a worker that already holds a warm ESLint costs nothing, so it
        // is never rate-limited and never gated on the process count — only on
        // how many may run at once.
        for (const worker of this.workers) {
            if (worker.recycle && worker.child && (worker.state === "parked" || worker.state === "waiting")) {
                this.dispatch(worker)
            }
        }

        while (this.active() < governor.limit) {
            const idle = this.workers.find((worker) => (worker.state === "parked" || worker.state === "waiting") && worker.child)

            if (!idle) {
                break
            }

            this.dispatch(idle)
        }

        if (this.active() >= governor.limit) {
            return
        }

        // The first fill goes out in one burst: the pool is sized to fit the
        // budget already, and every second a worker spends loading the config
        // before the next one even starts is a second nobody lints. Later
        // spawns — after a crash or a recycle — are staggered, so a restart
        // wave does not become a load spike of its own. Never hold more live
        // workers than the safeguard allows.
        if (this.filled && Date.now() - this.spawned < guard.spawn) {
            return
        }

        const burst = !this.filled
        let live = this.workers.filter((worker) => worker.child !== null).length

        while (live < governor.limit) {
            const cold = this.workers.find((worker) => worker.state === "cold" && !worker.child)

            if (!cold || (cold.queue.length === 0 && this.pending() === 0)) {
                break
            }

            this.spawn(cold)
            live += 1
            this.filled = true

            if (!burst) {
                break
            }
        }
    }
}
