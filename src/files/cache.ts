/**
 * The shared cache. A flat-cache file cannot be shared between processes,
 * so every worker writes its own and the parent folds them into one.
 */

import fs from "node:fs"
import path from "node:path"

import { paths } from "../constants.ts"
import { eslint } from "../workers/eslint.ts"

/** The shared cache and the workers' partial files. */
export const cache = {
    /**
     * flat-cache is what ESLint writes its cache with. It is ESLint's own
     * dependency, so it is resolved from ESLint's tree rather than assumed to
     * be hoisted next to ours.
     */
    flat(cwd: string): Files.FlatCacheModule {
        const require = eslint.require(cwd)
        const from = (request: string, base: string): string => require.resolve(request, { paths: [path.dirname(base)] })
        const entries = from("file-entry-cache", require.resolve("eslint"))

        return require(from("flat-cache", entries)) as Files.FlatCacheModule
    },

    /** A cache file, whichever flat-cache API the project's ESLint ships. */
    open(flat: Files.FlatCacheModule, id: string, dir: string): Files.FlatCache {
        if (typeof flat.load === "function") {
            return flat.load(id, dir)
        }

        if (typeof flat.create === "function") {
            return flat.create({ cacheId: id, cacheDir: dir })
        }

        throw new Error("Unsupported flat-cache version: neither load() nor create() is exported")
    },

    /** The cache directory inside the project. */
    dir(cwd: string): string {
        return path.join(cwd, paths.cache.dir)
    },

    /** The merged file every worker starts from. */
    shared(cwd: string): string {
        return path.join(this.dir(cwd), paths.cache.file)
    },

    /** The file one worker writes. */
    worker(cwd: string, index: number): string {
        return path.join(this.dir(cwd), `worker-${index}.json`)
    },

    /**
     * Fold the workers' cache files into the shared one.
     *
     * Every worker starts from a copy of the shared file and writes its own.
     * After the run — and before the next one, to pick up what an interrupted
     * run left behind — the copies are merged back: an entry that differs from
     * what the worker started with is one it linted, and wins. Entries for
     * files that no longer exist are dropped. Returns how many entries were
     * refreshed.
     */
    merge(cwd: string): number {
        const dir = this.dir(cwd)
        let partials: string[]

        try {
            partials = fs.readdirSync(dir).filter((name) => name.endsWith(".json") && name !== paths.cache.file)
        } catch {
            return 0
        }

        if (partials.length === 0) {
            return 0
        }

        const flat = this.flat(cwd)
        const merged = this.open(flat, paths.cache.file, dir)
        const before = new Map(Object.entries(merged.all()).map(([file, entry]) => [file, JSON.stringify(entry)]))
        let refreshed = 0

        for (const name of partials) {
            const partial = this.open(flat, name, dir)

            for (const [file, entry] of Object.entries(partial.all())) {
                if (before.get(file) !== JSON.stringify(entry)) {
                    merged.setKey(file, entry)
                    refreshed += 1
                }
            }
        }

        for (const file of merged.keys()) {
            if (!fs.existsSync(file)) {
                merged.removeKey(file)
            }
        }

        merged.save(true)

        for (const name of partials) {
            fs.rmSync(path.join(dir, name), { force: true })
        }

        return refreshed
    },
}
