/**
 * Warm workers: where their sockets live, what makes one stale, and how to
 * shut them all down.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { warm } from "../constants.ts"
import { connect } from "./ipc.ts"

/** This module's own path. */
const here = fileURLToPath(import.meta.url)

/** Warm workers on disk. */
export const daemon = {
    /**
     * The script a worker process runs. Next to this module, with the same
     * extension — so it works from the compiled tree and from the sources.
     */
    entry: path.join(path.dirname(here), `worker${path.extname(here)}`),

    /** This package's version; part of the epoch. */
    version: (createRequire(import.meta.url)("../../package.json") as { version: string }).version,

    /** The sockets live outside the project, keyed by its path. */
    dir(cwd: string): string {
        const id = crypto.createHash("md5").update(cwd).digest("hex").slice(0, 8)

        return path.join(os.tmpdir(), `concurrent-eslint-${id}`)
    },

    /** The socket file of the worker with this token. */
    socket(dir: string, token: string): string {
        return path.join(dir, `w-${token}.sock`)
    },

    /** Where a worker's stderr goes, next to its socket. */
    stderr(socket: string): string {
        return socket.replace(/\.sock$/, ".stderr")
    },

    /** A worker that is gone leaves no files behind. */
    forget(socket: string): void {
        fs.rmSync(socket, { force: true })
        fs.rmSync(this.stderr(socket), { force: true })
    },

    /** Every socket file in the directory, dead ones included. */
    list(dir: string): string[] {
        try {
            return fs.readdirSync(dir)
                .filter((name) => name.endsWith(".sock"))
                .map((name) => path.join(dir, name))
        } catch {
            return []
        }
    },

    /**
     * What a warm worker was built from. A worker whose epoch differs from the
     * client's is stale — another version of this tool, config, Node or
     * dependency tree — and is shut down instead of adopted. ESLint caches the
     * config module for the life of the process, so even a config edit has to
     * restart the workers.
     */
    epoch(cwd: string, config: string): string {
        const mtime = (file: string): string => {
            try {
                return String(fs.statSync(file).mtimeMs)
            } catch {
                return "-"
            }
        }

        const parts = [
            process.version,
            this.version,
            mtime(this.entry),
            mtime(config),
            mtime(path.join(cwd, "package.json")),
            mtime(path.join(cwd, "yarn.lock")),
            mtime(path.join(cwd, "package-lock.json")),
            mtime(path.join(cwd, "pnpm-lock.yaml")),
            mtime(path.join(cwd, "node_modules", ".yarn-integrity")),
            mtime(path.join(cwd, "node_modules", ".package-lock.json")),
            mtime(path.join(cwd, "node_modules", ".modules.yaml")),
        ]

        return crypto.createHash("md5").update(parts.join("|")).digest("hex").slice(0, 12)
    },

    /** Ask every warm worker of this project to exit. Returns how many did. */
    async stop(dir: string): Promise<number> {
        let stopped = 0

        await Promise.all(this.list(dir).map(async (socketPath) => {
            try {
                const { socket, io, hello } = await connect<Workers.Request>(socketPath, warm.probe)

                if (hello.type === "hello") {
                    io.send({ type: "shutdown" })
                    stopped += 1
                }

                socket.end()
            } catch {
                // Nobody there — just the file.
            }

            this.forget(socketPath)
        }))

        return stopped
    },
}
