/**
 * File discovery and the shared cache.
 * Ambient — available everywhere without an import.
 */
declare namespace Files {
    /** What the tree walk takes. */
    interface WalkOptions {
        /** Directory to walk. */
        cwd: string
        /** Extensions to keep, without the dot. */
        extensions: string[]
        /** Called with the running count after every kept file. */
        tick?: (count: number) => void
    }

    /** What the git lookup takes. */
    interface ChangedOptions {
        /** Directory to run git in; only files under it are returned. */
        cwd: string
        /** A ref to diff against, on top of the working tree. */
        base: string | null
    }

    /** The slice of flat-cache's API the merge relies on. */
    interface FlatCache {
        /** Every entry, keyed by file path. */
        all(): Record<string, unknown>
        /** Every file path in the cache. */
        keys(): string[]
        /** Set an entry. */
        setKey(key: string, value: unknown): void
        /** Drop an entry. */
        removeKey(key: string): void
        /** Write to disk; `true` skips pruning (v4) or forces the write (v6). */
        save(noPrune?: boolean): void
    }

    /**
     * flat-cache 4/5 (ESLint 8/9) exposes `load(id, dir)`; flat-cache 6
     * (ESLint 10) replaced it with `create({ cacheId, cacheDir })`.
     */
    interface FlatCacheModule {
        /** flat-cache 4/5: load or create the cache `cacheId` in `cacheDir`. */
        load?(cacheId: string, cacheDir: string): FlatCache
        /** flat-cache 6: the same, by options. */
        create?(options: { cacheId: string; cacheDir: string }): FlatCache
    }
}
