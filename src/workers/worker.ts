/**
 * The worker process. Listens on a unix socket, serves one client at a
 * time, lints the batches it is sent and reports every file back.
 *
 * Started by the parent with the CE_* variables set; never imported.
 */

import fs from "node:fs"
import fsp from "node:fs/promises"
import net from "node:net"
import path from "node:path"

import type { ESLint } from "eslint"

import { warm } from "../constants.ts"
import { machine } from "../system/resources.ts"
import { daemon } from "./daemon.ts"
import { eslint } from "./eslint.ts"
import { frame } from "./ipc.ts"

/** The worker side of the protocol. */
export const worker = {
    /** How much of the file --fix actually rewrote. */
    diff(before: string, after: string): number {
        const a = before.split("\n")
        const b = after.split("\n")
        let changed = 0

        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (a[i] !== b[i]) {
                changed += 1
            }
        }

        return changed
    },

    /** What of a lint result goes over the wire. */
    pack(result: ESLint.LintResult, fixedLines: number): Workers.Result {
        return {
            filePath: result.filePath,
            errorCount: result.errorCount,
            warningCount: result.warningCount,
            fixableErrorCount: result.fixableErrorCount,
            fixableWarningCount: result.fixableWarningCount,
            fixedLines,
            messages: result.messages.map((message) => ({
                line: message.line,
                column: message.column,
                severity: message.severity,
                message: message.message,
                ruleId: message.ruleId,
            })),
        }
    },

    /** A required CE_* variable. */
    env(name: string): string {
        const value = process.env[name]

        if (!value) {
            throw new Error(`${name} is not set — this script is started by concurrent-eslint, not by hand`)
        }

        return value
    },

    /** Listen on the socket and serve until told to leave. */
    run(): void {
        const token = this.env("CE_TOKEN")
        const socketPath = this.env("CE_SOCKET")
        const epoch = this.env("CE_EPOCH")
        const heap = Number(process.env.CE_HEAP)
        const persistent = process.env.CE_PERSIST === "1"
        const idle = persistent ? warm.idle : warm.orphan

        let client: net.Socket | null = null
        let sleeper: NodeJS.Timeout | null = null
        let trimmer: NodeJS.Timeout | null = null
        let server: net.Server | null = null
        let idleBudget = 0
        // The slot this worker last served, so the next run can hand it the same
        // slice of the tree: its caches then cover the modules that slice
        // imports, instead of growing towards the whole project.
        let shard = -1

        const leave = (code: number): never => {
            server?.close()
            daemon.forget(socketPath)
            process.exit(code)
        }

        const rearm = (): void => {
            if (sleeper) {
                clearTimeout(sleeper)
            }

            sleeper = setTimeout(() => leave(0), idle)
        }

        // Listen first, load ESLint second: the parent's connect timeout is short
        // and the plugins take seconds. The loading starts right away so a job
        // arriving later finds it done — or finds the failure, reported then.
        const loading = eslint.load(process.cwd())

        loading.catch(() => {})

        /**
         * One client at a time. Every job gets a fresh ESLint instance — that is
         * cheap once the plugins are loaded — while the module-level caches the
         * plugins keep survive from job to job.
         */
        const serve = (socket: net.Socket): void => {
            const io = frame<Workers.Request, Workers.Reply>(socket)

            if (client) {
                io.send({ type: "busy" })
                socket.end()

                return
            }

            client = socket

            if (sleeper) {
                clearTimeout(sleeper)
            }

            if (trimmer) {
                clearTimeout(trimmer)
            }

            let Linter: typeof ESLint | null = null
            let linter: ESLint | null = null
            let job: Workers.Job | null = null

            const { send } = io

            const lint = async (files: string[]): Promise<void> => {
                send({ type: "start", file: files[0], batch: files.length })

                let results: ESLint.LintResult[] = []
                let failure: string | null = null

                try {
                    if (!linter || !Linter || !job) {
                        throw new Error("batch before job")
                    }

                    // One call for the whole batch. Linting files one at a time costs
                    // roughly 1.8x the wall clock and 2x the CPU of a batched call —
                    // ESLint redoes a lot of per-invocation work otherwise.
                    results = await linter.lintFiles(files)
                } catch (error) {
                    failure = error instanceof Error ? error.message : String(error)
                }

                if (failure) {
                    for (const file of files) {
                        send({ type: "result", file, failure, result: null })
                    }

                    send({ type: "idle" })

                    return
                }

                const reported = new Set<string>()

                for (const result of results) {
                    let fixedLines = 0

                    if (job!.fix && result.output !== undefined) {
                        // outputFixes writes the file, so capture the original first.
                        const before = await fsp.readFile(result.filePath, "utf8").catch(() => null)

                        await Linter!.outputFixes([result])
                        fixedLines = before === null ? 1 : this.diff(before, result.output)
                    }

                    reported.add(path.resolve(result.filePath))
                    send({ type: "result", file: result.filePath, failure: null, result: this.pack(result, fixedLines) })
                }

                // ESLint can return fewer results than inputs; the parent counts one
                // result per dispatched file, so account for the rest or the run hangs.
                for (const file of files) {
                    if (!reported.has(path.resolve(file))) {
                        // No result means ESLint ignored it: counted, but not a checked file.
                        send({ type: "result", file, failure: null, result: null, ignored: true })
                    }
                }

                send({ type: "idle" })
            }

            const handle = async (message: Workers.Request): Promise<void> => {
                switch (message.type) {
                    case "job":
                        job = message.options
                        idleBudget = job.idleBudget ?? 0
                        shard = job.shard ?? -1
                        Linter = await loading
                        linter = new Linter({
                            cwd: job.cwd,
                            fix: job.fix,
                            cache: job.cache,
                            cacheLocation: job.cacheLocation,
                            cacheStrategy: job.cacheStrategy,
                            errorOnUnmatchedPattern: false,
                            warnIgnored: false,
                        })
                        send({ type: "ready" })
                        break
                    case "batch":
                        await lint(message.files)
                        break
                    case "release":
                        socket.end()
                        break
                    case "shutdown":
                        leave(0)
                        break
                    default:
                        break
                }
            }

            io.on((message) => {
                handle(message).catch((error: unknown) => {
                    send({ type: "fatal", error: error instanceof Error ? error.message : String(error) })
                    leave(1)
                })
            })

            socket.on("error", () => {
                // The close that follows is what matters.
            })

            // Losing the client is a release either way: a warm worker goes back to
            // sleep, a one-shot one has nothing left to do.
            socket.on("close", () => {
                client = null
                linter = null

                if (!persistent) {
                    leave(0)
                }

                rearm()

                // The job's ASTs and results are garbage now; without a collection
                // they sit in the idle worker's heap until the next job. Only the
                // plugins' module-level caches are meant to survive. Once V8 has had
                // its idle time to return pages, a worker still past the share of
                // memory a sleeping one is allowed is not worth keeping.
                globalThis.gc?.()

                if (trimmer) {
                    clearTimeout(trimmer)
                }

                trimmer = setTimeout(() => {
                    globalThis.gc?.()

                    if (!client && idleBudget > 0 && machine.rss(process.pid) > idleBudget) {
                        leave(0)
                    }
                }, warm.trim)
            })

            send({ type: "hello", pid: process.pid, token, epoch, heap, shard })
        }

        server = net.createServer(serve)
        fs.rmSync(socketPath, { force: true })
        server.listen(socketPath)
        rearm()

        process.on("SIGTERM", () => leave(0))
    },
}

if (process.env.CE_WORKER === "1") {
    try {
        worker.run()
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
        process.exit(1)
    }
}
