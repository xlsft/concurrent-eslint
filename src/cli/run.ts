/**
 * One run, start to finish: parse the arguments, find the files, size the
 * pool, lint, summarize. Returns the exit code.
 */

import fs from "node:fs"
import path from "node:path"

import { bar, guard, paths } from "../constants.ts"
import { cache } from "../files/cache.ts"
import { files } from "../files/discovery.ts"
import { plan as size } from "../system/sizing.ts"
import { Reporter } from "../ui/reporter.ts"
import { ESC, palette, text } from "../ui/terminal.ts"
import { daemon } from "../workers/daemon.ts"
import { Pool } from "../workers/pool.ts"
import { help } from "./help.ts"
import { args } from "./options.ts"
import { summary } from "./summary.ts"

/** Lint with the given command-line arguments. Resolves to the exit code. */
export const run = async (argv: string[], { cwd = process.cwd() }: Cli.RunOptions = {}): Promise<number> => {
    const { plural } = text
    let options: Cli.Options

    try {
        options = args.parse(argv)
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)

        return 2
    }

    if (options.help) {
        process.stdout.write(help())

        return 0
    }

    const c = palette(options.color)
    const config = await files.config(cwd)

    if (!config) {
        process.stderr.write(`${c.red("No eslint.config.* found")} in ${cwd}\n`)

        return 2
    }

    /* --- file discovery ---------------------------------------------- */

    const started = Date.now()
    let found = 0

    const spinner = process.stdout.isTTY && !options.headless
        ? setInterval(() => {
            const frame = bar.spinner[Math.floor(Date.now() / 80) % bar.spinner.length]

            process.stdout.write(`\r${ESC}[2K ${c.cyan(frame)} ${c.dim(`globbing — ${found}…`)}`)
        }, 80)
        : null

    const extensions = new Set(paths.extensions.map((ext) => `.${ext}`))

    // The parent never loads the config: the walk is a plain readdir with the
    // hard skips, and in --changed mode git already knows the answer. Either
    // way ESLint's ignore rules get the final say inside the workers.
    const find = async (): Promise<string[]> => {
        if (!options.changed) {
            return files.walk({
                cwd,
                extensions: paths.extensions,
                tick: (kept) => {
                    found = kept
                },
            })
        }

        const candidates = files.changed({ cwd, base: options.since })
            .filter((file) => extensions.has(path.extname(file)))

        found = candidates.length

        return candidates.sort()
    }

    const discovery = find().finally(() => {
        if (spinner) {
            clearInterval(spinner)
            process.stdout.write(`\r${ESC}[2K`)
        }
    })

    /* --- warm workers ------------------------------------------------- */

    const sockets = daemon.dir(cwd)

    if (options.stopDaemon) {
        // Discovery is already running; let it finish quietly.
        discovery.catch(() => {})

        const count = await daemon.stop(sockets)
        const notes = [count > 0 ? c.green(`${bar.done} stopped ${plural(count, "warm worker")}`) : c.dim("no warm workers were running")]

        if (options.prune) {
            const had = fs.existsSync(cache.shared(cwd))

            fs.rmSync(cache.dir(cwd), { recursive: true, force: true })
            notes.push(had ? c.green(`${bar.done} cache dropped`) : c.dim("no cache to drop"))
        }

        process.stdout.write(`\n ${notes.join("  ")}\n\n`)

        return 0
    }

    fs.mkdirSync(sockets, { recursive: true })

    /* --- shared cache ------------------------------------------------- */

    // Whatever an interrupted run left behind is folded in first, so no
    // worker starts from a stale copy.
    if (options.cache) {
        fs.mkdirSync(cache.dir(cwd), { recursive: true })
        cache.merge(cwd)
    }

    /* --- safeguard: how many workers we may run at all ---------------- */

    const plan = size(options)
    const flags = [
        options.fix ? "--fix" : null,
        options.quiet ? "--quiet" : null,
        options.cache ? `--cache (${options.cacheStrategy})` : null,
        options.headless ? "--headless" : null,
        options.daemon ? null : "--no-daemon",
    ]
        .filter(Boolean)
        .join(" ")

    const pool = new Pool({ cwd, options, palette: c, sockets, epoch: daemon.epoch(cwd, config), plan })

    const interrupt = (): void => {
        pool.interrupt()
        process.stdout.write(`\n ${c.yellow("Interrupted")}\n\n`)
        process.exit(130)
    }

    process.on("SIGINT", interrupt)

    // Fill the pool while discovery is still walking the tree.
    pool.start()

    const all = await discovery
    const roots = options.paths.map((entry) => path.resolve(cwd, entry))
    const list = roots.length === 0
        ? all
        : all.filter((file) => roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`)))

    const took = ((Date.now() - started) / 1000).toFixed(1)
    const scope = options.changed ? `changed vs ${options.since ?? "HEAD"}` : "globbed"

    if (list.length === 0) {
        await pool.shutdown()
        process.off("SIGINT", interrupt)

        const why = options.changed
            ? `nothing changed vs ${options.since ?? "HEAD"}`
            : `config: ${path.basename(config)}`

        process.stdout.write(`\n ${c.green(`${bar.done} Nothing to lint`)} ${c.dim(`(${why})`)}\n\n`)

        return 0
    }

    const { threads } = plan

    // The header says whether the run starts warm, so the warm workers have
    // to be known by now; probing them takes milliseconds.
    await pool.adoption

    const warmth = pool.warmed() > 0 ? c.orange("(warm)") : c.cyan("(cold)")

    process.stdout.write(`\n ${c.bold(c.cyan("concurrent-eslint"))}  ${c.dim(`${path.basename(config)} · ${scope} in ${took}s`)}\n`)
    process.stdout.write(` ${c.dim(`${plural(list.length, "file")} · ${plural(threads, "worker")}`)} ${warmth} ${c.dim(`· ${plural(plan.cores, "core")} · ${plan.heap} MB heap per worker${flags ? ` · ${flags}` : ""}`)}\n`)

    if (plan.overcommitted) {
        process.stdout.write(` ${c.yellow("memory:")} ${c.dim(`only ${(plan.available / 1073741824).toFixed(1)}G of the ${plan.budgetGb}G budget is free — the pool will wait for room before it starts`)}\n`)
    } else if (plan.bound) {
        process.stdout.write(` ${c.yellow("memory-bound:")} ${c.dim(`a ${plan.budgetGb}G budget holds ${plural(plan.affordable, "worker")} at ~${guard.heap.rss} MB each, CPU would allow ${plan.expected}`)}\n`)
    }

    if (!options.safeguard) {
        process.stdout.write(` ${c.red("safeguard off")} ${c.dim("— nothing will stop this from taking the machine down")}\n`)
    } else if (threads < plan.requested) {
        process.stdout.write(` ${c.yellow("safeguard:")} ${c.dim(`${plural(plan.requested, "worker")} requested, running ${Math.min(threads, plan.size)} of ${threads} slots (CPU ≤ ${options.maxCpu}%, RAM ≤ ${options.maxMemory}% = ${plan.budgetGb}G of ${plan.totalGb}G)`)}\n`)
    } else {
        process.stdout.write(` ${c.dim(`safeguard: running ${Math.min(threads, plan.size)} of ${threads} slots · CPU ≤ ${options.maxCpu}%, RAM ≤ ${options.maxMemory}% = ${plan.budgetGb}G of ${plan.totalGb}G`)}\n`)
    }

    /* --- worker pool --------------------------------------------------- */

    // Deal into the number of workers that will actually run, not into every
    // slot. Sharding across slots the safeguard will never open just means the
    // running workers have to steal it all back one empty queue at a time.
    // Spinning up a worker that will lint three files is a net loss.
    const useful = Math.max(1, Math.ceil(list.length / guard.perWorker))

    pool.governor.cap(useful)

    const shards = Math.max(1, Math.min(
        options.safeguard ? Math.min(threads, plan.size) : threads,
        useful,
        list.length,
    ))

    pool.assign(list, shards)

    const reporter = new Reporter({
        palette: c,
        workers: pool.workers,
        total: list.length,
        governor: pool.governor,
        stream: process.stdout,
        headless: options.headless,
    })

    pool.attach(reporter)
    reporter.start()
    pool.begin()

    await pool.finished

    reporter.stop()
    process.off("SIGINT", interrupt)

    const refreshed = pool.merge()

    /* --- summary ------------------------------------------------------ */

    return summary({
        palette: c,
        options,
        plan,
        totals: pool.totals,
        governor: pool.governor,
        files: list.length,
        seconds: reporter.elapsed(),
        average: pool.average(),
        refreshed,
    })
}
