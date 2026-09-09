/**
 * ESLint is a peer dependency: the project's own copy is what lints, so it
 * is resolved from the project, not from wherever this package is installed.
 */

import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { ESLint } from "eslint"

/** Finding and loading the project's ESLint. */
export const eslint = {
    /** Path of the project's `eslint` entry point, falling back to our own tree. */
    resolve(cwd: string): string {
        const bases = [path.join(cwd, "package.json"), import.meta.url]

        for (const base of bases) {
            try {
                return createRequire(base).resolve("eslint")
            } catch {
                // try the next base
            }
        }

        throw new Error(`Cannot find "eslint" from ${cwd} — install it in the project (npm i -D eslint)`)
    },

    /** A `require` rooted at the project's ESLint, for its transitive dependencies. */
    require(cwd: string): NodeJS.Require {
        return createRequire(this.resolve(cwd))
    },

    /** The ESLint class, imported from the project's copy. */
    async load(cwd: string): Promise<typeof ESLint> {
        const module = await import(pathToFileURL(this.resolve(cwd)).href) as Workers.EslintModule
        const ctor = module.ESLint ?? module.default?.ESLint

        if (!ctor) {
            throw new Error("The resolved eslint package does not export ESLint")
        }

        return ctor
    },
}
