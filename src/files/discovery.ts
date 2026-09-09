/**
 * Which files to lint. The parent never loads the ESLint config: the walk
 * is a plain readdir with the hard skips, and in --changed mode git already
 * knows the answer. ESLint's own ignore rules get the final say inside the
 * workers, which have the config loaded anyway.
 */

import childProcess from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import { paths } from "../constants.ts"

/** Finding the files to lint and spreading them across workers. */
export const files = {
    /** The eslint.config.* in cwd, or null. */
    async config(cwd: string): Promise<string | null> {
        for (const name of paths.configs) {
            const candidate = path.join(cwd, name)

            try {
                await fsp.access(candidate)

                return candidate
            } catch {
                // keep looking
            }
        }

        return null
    },

    /** Lines of a git command's output. */
    git(argv: string[], cwd: string): string[] {
        return childProcess.execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
    },

    /**
     * Files git considers changed. Without a base ref that means the working
     * tree against HEAD plus anything untracked; with one, everything that
     * diverged from the merge base as well — the set a review would look at.
     * Deletions are filtered out: there is nothing left to lint.
     */
    changed({ cwd, base }: Files.ChangedOptions): string[] {
        let root: string

        try {
            root = this.git(["rev-parse", "--show-toplevel"], cwd)[0]
        } catch {
            throw new Error("--changed needs a git repository, and this is not one")
        }

        const relative = new Set<string>()
        const add = (list: string[]): void => {
            for (const entry of list) {
                relative.add(entry)
            }
        }

        try {
            add(this.git(["diff", "--name-only", "--diff-filter=d", "HEAD"], cwd))
        } catch {
            // A repository with no commits yet has no HEAD to diff against.
        }

        add(this.git(["ls-files", "--others", "--exclude-standard"], cwd))

        if (base) {
            let range: string

            try {
                range = this.git(["merge-base", base, "HEAD"], cwd)[0] || base
            } catch {
                throw new Error(`--since: cannot resolve "${base}" against HEAD`)
            }

            add(this.git(["diff", "--name-only", "--diff-filter=d", range], cwd))
        }

        // git prints paths from the repository root, which is not necessarily cwd.
        return [...relative]
            .map((entry) => path.resolve(root, entry))
            .filter((file) => file.startsWith(`${cwd}${path.sep}`) && fs.existsSync(file))
    },

    /**
     * Walk the tree for candidates. Only the hard skips apply here: the
     * config's own ignore rules are left to the workers, which have the config
     * loaded anyway and drop an ignored file for free. Asking ESLint from the
     * parent means loading every plugin — seconds — to spare the workers a
     * handful of files.
     */
    async walk({ cwd, extensions, tick }: Files.WalkOptions): Promise<string[]> {
        const wanted = new Set(extensions.map((ext) => `.${ext}`))
        const found: string[] = []

        const visit = async (dir: string): Promise<void> => {
            let entries: fs.Dirent[]

            try {
                entries = await fsp.readdir(dir, { withFileTypes: true })
            } catch {
                return
            }

            const dirs: string[] = []

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (!paths.skip.has(entry.name)) {
                        dirs.push(path.join(dir, entry.name))
                    }

                    continue
                }

                if (!entry.isFile() && !entry.isSymbolicLink()) {
                    continue
                }

                if (!wanted.has(path.extname(entry.name))) {
                    continue
                }

                found.push(path.join(dir, entry.name))
                tick?.(found.length)
            }

            for (const sub of dirs) {
                await visit(sub)
            }
        }

        await visit(cwd)

        return found.sort()
    },

    /**
     * Contiguous slices of the sorted list, so a worker gets whole directories.
     * Files next to each other import the same modules, and import-x builds an
     * export map for every module a worker's files import — once per worker.
     * Dealing round-robin spreads heavy .vue files evenly but makes every worker
     * parse nearly every module; slicing measured 9% faster end to end, and
     * work stealing evens out the load either way.
     */
    shard<T>(list: T[], count: number): T[][] {
        const edge = (index: number): number => Math.floor((index * list.length) / count)

        return Array.from({ length: count }, (_unused, index) => list.slice(edge(index), edge(index + 1)))
    },
}
