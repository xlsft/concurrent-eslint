/**
 * Command line: parsed options, the run and its summary.
 * Ambient — available everywhere without an import.
 */
declare namespace Cli {
    /** What marks a cached file as changed: its content hash, or mtime + size. */
    type CacheStrategy = "metadata" | "content"

    /** Command-line options, as parsed. */
    interface Options {
        /** Worker ceiling. */
        threads: number
        /** Apply auto-fixable fixes. */
        fix: boolean
        /** Report errors only, no warnings. */
        quiet: boolean
        /** Reuse results for unchanged files. */
        cache: boolean
        /** What marks a cached file as changed. */
        cacheStrategy: CacheStrategy
        /** Exit 1 past this many warnings; -1 disables the check. */
        maxWarnings: number
        /** CPU budget in percent. */
        maxCpu: number
        /** Memory budget in percent of the machine (or cgroup) limit. */
        maxMemory: number
        /** Keep CPU and memory under budget by parking and killing workers. */
        safeguard: boolean
        /** No live UI, full-length messages. */
        headless: boolean
        /** Only files git reports as changed. */
        changed: boolean
        /** With `changed`: also everything that diverged from this ref. */
        since: string | null
        /** Keep workers alive after the run. */
        daemon: boolean
        /** Shut the warm workers down and exit. */
        stopDaemon: boolean
        /** With `stopDaemon`: drop the cache too. */
        prune: boolean
        /** Colored output. */
        color: boolean
        /** Restrict the run to these files and directories. */
        paths: string[]
        /** Print the help and exit. */
        help: boolean
    }

    /** What parsing looks at besides argv. */
    interface Environment {
        /** Whether stdout is a terminal. */
        isTTY: boolean
        /** Process environment: NO_COLOR and CI are read. */
        env: NodeJS.ProcessEnv
    }

    /** What `run()` takes besides argv. */
    interface RunOptions {
        /** Defaults to process.cwd(). */
        cwd?: string
    }

    /** What the summary is rendered from. */
    interface Summary {
        /** Colors. */
        palette: Ui.Palette
        /** The parsed command line. */
        options: Options
        /** How the pool was sized. */
        plan: System.Plan
        /** Counts accumulated over the run. */
        totals: Workers.Totals
        /** The safeguard's final readings. */
        governor: System.GovernorState
        /** Files that went into the pool. */
        files: number
        /** Wall-clock seconds the run took. */
        seconds: number
        /** Workers busy on average over the run. */
        average: number
        /** Cache entries refreshed by this run. */
        refreshed: number
        /** Terminal width; defaults to stdout's. */
        columns?: number
    }
}
