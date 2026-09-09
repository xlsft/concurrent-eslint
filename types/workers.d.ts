/**
 * Worker processes: the wire protocol, sockets, slots and the pool.
 * Ambient — available everywhere without an import.
 */
declare namespace Workers {
    /* ------------------------------------------------------------ */
    /* Wire protocol: newline-delimited JSON, one object per line    */
    /* ------------------------------------------------------------ */

    /** What a worker needs to build its ESLint instance. */
    interface Job {
        /** The project root ESLint runs in. */
        cwd: string
        /** Apply auto-fixable fixes. */
        fix: boolean
        /** Read and write an ESLint cache. */
        cache: boolean
        /** This worker's own cache file; undefined without `cache`. */
        cacheLocation: string | undefined
        /** What marks a cached file as changed. */
        cacheStrategy: Cli.CacheStrategy
        /** Resident size past which an idle warm worker exits instead of sleeping. */
        idleBudget: number
        /** The slot this worker serves, so the next run can hand it the same slice. */
        shard: number
    }

    /** Parent → worker. */
    type Request =
        | { type: "job"; options: Job }
        | { type: "batch"; files: string[] }
        | { type: "release" }
        | { type: "shutdown" }

    /** One lint message, as much of it as the parent prints. */
    interface Message {
        /** 1-based line, if the message points at one. */
        line: number | undefined
        /** 1-based column, if the message points at one. */
        column: number | undefined
        /** 1 for a warning, 2 for an error. */
        severity: number
        /** The rule's text. */
        message: string
        /** The rule that fired; null for a parse error. */
        ruleId: string | null
    }

    /** One file's lint result, as much of it as the parent needs. */
    interface Result {
        /** Absolute path. */
        filePath: string
        /** Errors in the file. */
        errorCount: number
        /** Warnings in the file. */
        warningCount: number
        /** Errors --fix could remove. */
        fixableErrorCount: number
        /** Warnings --fix could remove. */
        fixableWarningCount: number
        /** How many lines --fix rewrote in this file. */
        fixedLines: number
        /** The messages, in file order. */
        messages: Message[]
    }

    /** A worker's greeting, sent on every new connection. */
    interface Hello {
        /** Discriminator. */
        type: "hello"
        /** The worker's process id. */
        pid: number
        /** The token in its socket name. */
        token: string
        /** What it was built from; a mismatch means it is stale. */
        epoch: string
        /** The heap it was started with, MB. */
        heap: number
        /** The slot it served last; -1 if none yet. */
        shard: number
    }

    /** One file's outcome. */
    interface Report {
        /** Discriminator. */
        type: "result"
        /** Absolute path of the file. */
        file: string
        /** Why linting failed, or null. */
        failure: string | null
        /** The result; null if ESLint returned none or linting failed. */
        result: Result | null
        /** ESLint returned nothing for the file: its config ignores it. */
        ignored?: boolean
    }

    /** Worker → parent. */
    type Reply =
        | Hello
        | { type: "busy" }
        | { type: "ready" }
        | { type: "start"; file: string; batch: number }
        | Report
        | { type: "idle" }
        | { type: "fatal"; error: string }

    /* ------------------------------------------------------------ */
    /* Sockets                                                       */
    /* ------------------------------------------------------------ */

    /** A socket with newline-delimited JSON on it. */
    interface Framed<In, Out> {
        /** Write one message; dropped if the socket is gone. */
        send(message: Out): void
        /** Replace the message handler. */
        on(next: (message: In) => void): void
    }

    /** A connected worker, greeting received. */
    interface Connection<Out = unknown> {
        /** The raw socket. */
        socket: import("node:net").Socket
        /** The framed view of it. */
        io: Framed<Reply, Out>
        /** The first message the worker sent — a greeting, or "busy". */
        hello: Reply
    }

    /** A warm worker that greeted us and is waiting for a job. */
    type Warm = Connection<Request> & { hello: Hello }

    /** The shape of the `eslint` package, whichever module format it ships. */
    interface EslintModule {
        /** The named export. */
        ESLint?: typeof import("eslint").ESLint
        /** The default export, when the package is CommonJS seen through import(). */
        default?: { ESLint?: typeof import("eslint").ESLint }
    }

    /* ------------------------------------------------------------ */
    /* The parent's view of a worker                                 */
    /* ------------------------------------------------------------ */

    /** Where a slot is in its life. */
    type State =
        /** No process behind the slot; its files are up for stealing. */
        | "cold"
        /** Process spawned, config loading. */
        | "starting"
        /** Warm and ready, but the pool has no files yet. */
        | "waiting"
        | "busy"
        /** Alive but idle: the safeguard says no more workers may run. */
        | "parked"
        | "done"

    /** What a link is made from. */
    interface LinkInit {
        /** The worker's process id. */
        pid: number
        /** The token in its socket name. */
        token: string
        /** Whether it stays alive after the run. */
        persistent: boolean
        /** The child process handle; null for an adopted worker. */
        proc: import("node:child_process").ChildProcess | null
    }

    /**
     * A worker as the parent sees it: a pid, a socket and whether it stays
     * alive after the run.
     */
    interface Link extends Readonly<LinkInit> {
        /** The socket, once connected. */
        socket: import("node:net").Socket | null
        /** Send a request; queued until the socket is up. */
        send(message: Request): void
        /** Signal the process; ignored if it is already gone. */
        kill(signal: NodeJS.Signals): void
        /** Wire a connected socket to this link and flush what was queued. */
        attach(socket: import("node:net").Socket, framed: Framed<Reply, Request>): void
    }

    /** One worker slot: its queue, its process and its counters. */
    interface Slot {
        /** Position in the pool, 0-based. */
        readonly index: number
        /** Files given to this slot, stealing included. */
        assigned: number
        /** Files accounted for. */
        done: number
        /** Errors found, lint failures included. */
        errors: number
        /** Warnings found. */
        warnings: number
        /** What the live view shows next to the bar. */
        current: string
        /** Where the slot is in its life. */
        state: State
        /** Ever had a process — a slot that never did is "spare", not "done". */
        started: boolean
        /** Files taken off other slots. */
        stolen: number
        /** Files handed to other slots. */
        reassigned: number
        /** Files --fix rewrote. */
        fixed: number
        /** Lines --fix rewrote. */
        lines: number
        /** Files not yet dispatched. */
        queue: string[]
        /** Dispatched, no result yet. */
        flight: string[]
        /** Files per batch. */
        batch: number
        /** Size of the batch in flight. */
        count: number
        /** When the batch in flight was sent. */
        since: number
        /** The live process, or null. */
        child: Link | null
        /** Marked for a restart between batches. */
        recycle: boolean
        /** How many times it has been restarted for memory. */
        recycled: number
        /** Resident size of the process, bytes, as of the last sample. */
        rss: number
        /** `done` when the current process started. */
        mark: number
    }

    /** A file that produced no result. */
    interface Failure {
        /** Path relative to cwd, or a worker's name. */
        file: string
        /** What went wrong. */
        error: string
    }

    /** Counts accumulated over the run. */
    interface Totals {
        /** Errors, lint failures and unchecked files included. */
        errors: number
        /** Warnings. */
        warnings: number
        /** Errors --fix could remove. */
        fixableErrors: number
        /** Warnings --fix could remove. */
        fixableWarnings: number
        /** Files with something to show. */
        problematic: number
        /** Files --fix rewrote. */
        fixed: number
        /** Lines --fix rewrote. */
        lines: number
        /** Times a worker was parked by the safeguard. */
        parked: number
        /** Parked workers killed for memory. */
        killed: number
        /** Workers restarted for memory. */
        recycled: number
        /** Workers that died of heap exhaustion. */
        oom: number
        /** Files moved between queues. */
        rebalanced: number
        /** Files ESLint's config ignores. */
        ignored: number
        /** Warm workers adopted from the last run. */
        adopted: number
        /** Resident size of all our workers, bytes, as of the last sample. */
        rss: number
        /** Milliseconds spent holding for memory. */
        held: number
        /** The largest `rss` seen. */
        peakRss: number
        /** The highest machine memory usage seen [0..1]. */
        peakMemory: number
        /** One line per worker crash. */
        crashes: string[]
        /** Files that produced no result. */
        failures: Failure[]
    }

    /** Everything the pool needs to know before it starts. */
    interface PoolConfig {
        /** The project root. */
        cwd: string
        /** The parsed command line. */
        options: Cli.Options
        /** Colors. */
        palette: Ui.Palette
        /** Directory the workers' sockets live in. */
        sockets: string
        /** What a worker must have been built from to be adopted. */
        epoch: string
        /** How the pool was sized. */
        plan: System.Plan
    }
}
