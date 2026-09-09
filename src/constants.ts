/**
 * Every tunable in one place, grouped by what it governs. The comments
 * explain why each number is what it is — most of them were arrived at by
 * watching the pool misbehave.
 */

/**
 * A braille cell fills bottom-up: left column first, then right.
 * That gives 8 sub-steps per character, so the bar moves smoothly.
 */
const cells = ["⠀", "⡀", "⡄", "⡆", "⡇", "⣇", "⣧", "⣷", "⣿"] as const

/** The live view. */
export const bar = {
    /** Fill levels of one cell, empty to full. */
    cells,
    /** Sub-steps per cell. */
    steps: cells.length - 1,
    /** Cells in a worker's bar. */
    width: 12,
    /** Frames of the busy spinner. */
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const,
    /** Mark of a finished worker. */
    done: "⣿",
    /** Mark of a parked worker. */
    parked: "⠶",
    /** Mark of a slot without a process. */
    cold: "⠈",
}

/** What is looked at on disk. */
export const paths = {
    /** Extensions the tree walk keeps. */
    extensions: ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue"],
    /** Where the shared cache lives, relative to the project. */
    cache: {
        /** The directory. */
        dir: ".eslintcache-concurrent",
        /** The merged file inside it. */
        file: "cache.json",
    },
    /** Directories the tree walk never enters. */
    skip: new Set([
        "node_modules", ".git", ".hg", ".svn", ".nuxt", ".output", ".nitro",
        ".cache", ".data", "dist", "coverage", ".yarn", ".pnpm-store",
    ]),
    /** Config file names, in lookup order. */
    configs: [
        "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
        "eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
    ],
}

/** The safeguard. */
export const guard = {
    /** Default CPU budget, percent. */
    cpu: 75,
    /** Default memory budget, percent. */
    memory: 75,
    /** Sampling period, ms. */
    interval: 500,
    /**
     * Gap between decisions, ms. Parking only takes effect once a worker
     * finishes its current batch, so a decision needs seconds to show up in
     * the samples. Re-deciding faster than that just stacks corrections on
     * top of each other and makes the pool oscillate, so both directions
     * wait out the actuation delay.
     */
    cooldown: 3000,
    /** Memory pressure and a genuinely pinned CPU can't wait that long. */
    emergency: {
        /** Gap between decisions under emergency, ms. */
        cooldown: 1000,
        /** Instant CPU usage that counts as pinned [0..1]. */
        cpu: 0.92,
    },
    /**
     * No integer worker count lands exactly on the CPU target, so the pool
     * sits slightly under it or slightly over. Both edges get a margin, or it
     * hunts between two levels forever — and the hunting itself burns more
     * CPU than the level above would have.
     */
    margin: {
        /** How far under the CPU budget before the pool may grow. */
        up: 0.12,
        /** How far over the CPU budget before the pool must shed at once. */
        down: 0.06,
    },
    /**
     * Windows of sustained overshoot before the pool sheds. Short bursts
     * above target are normal — the pool sheds only on a real spike or on an
     * overshoot that persists this long. Reacting to every peak costs more,
     * in CPU and in wall clock, than the peak itself.
     */
    windows: 3,
    /** Minimum gap between staggered spawns, ms. */
    spawn: 700,
    /**
     * Cores one worker really costs. A lint worker is not one core's worth
     * of work: V8 runs GC and compilation on background threads, so a busy
     * worker measures at roughly this many cores. Sizing the pool as
     * cores/1 overshoots the CPU budget, and the governor then spends the
     * whole run shedding what it just added.
     */
    cost: 1.35,
    /**
     * Files that justify one more worker. A worker spends a few seconds
     * loading the config before it lints anything, so below roughly this
     * many files an extra worker costs more than it saves.
     */
    perWorker: 25,
    /**
     * A worker's footprint grows the whole time it lints — ESLint holds on
     * to parsed state between calls — so a long-lived worker is a slow leak.
     * Past its share of the memory budget it gets recycled: killed between
     * batches and started again with its queue intact.
     */
    recycle: {
        /** Share of the memory budget a worker may reach before it is recycled. */
        headroom: 0.8,
        /**
         * Minimum gap between recyclings, ms. Recycling costs a full config
         * load, so it is rate-limited hard. Without this, sustained pressure
         * marks a worker on every sample and the pool spends the whole run
         * restarting instead of linting.
         */
        cooldown: 20000,
        /** Files a worker must have done to be worth the restart. */
        min: 100,
    },
    /** Memory pressure. */
    ram: {
        /**
         * Windows of sustained pressure before the pool itself shrinks.
         * Shrinking is the wrong answer to our own growth (fewer workers means
         * one worker lints more files and grows further), so recycling comes
         * first.
         */
        windows: 4,
        /** Never starve the pool below this many workers on memory alone. */
        floor: 2,
        /**
         * Hysteresis on the memory side of the ramp-up decision. Small on
         * purpose: a wide margin does not damp anything, it just makes memory
         * usage well below the limit silently prevent the pool from growing.
         */
        margin: 0.03,
        /**
         * Past the budget by this much the pool stops taking new work and
         * waits for memory to come back instead of shrinking itself for good.
         */
        hold: 0.05,
        /**
         * How long a hold lasts at most, ms. Waiting forever is worse than
         * overshooting: if the memory was never ours it may never come back.
         */
        wait: 90000,
    },
    /** Per-worker heap. */
    heap: {
        /**
         * Smallest viable heap, MB. A worker with less does not run slower —
         * it dies. Sizing the heap by "budget / slots" is what produced 1.3 GB
         * workers on a 16 GB box and an OOM loop; if the budget cannot afford
         * this much per worker, the answer is fewer workers, never a smaller
         * heap.
         */
        min: 2048,
        /** Largest heap, MB. */
        max: 4096,
        /** A worker killed by the heap limit gets a heap this much bigger. */
        bump: 1.5,
        /**
         * What a worker actually resides at, MB, as opposed to the heap
         * ceiling it is allowed to reach. Sizing the pool against the ceiling
         * assumes every worker instantly claims its cap — roughly double what
         * they really take.
         */
        rss: 1536,
    },
    /** How many times a file that killed a worker is retried before giving up. */
    attempts: 2,
    /**
     * Batch sizing. Every lintFiles() call ends with ESLint rewriting its
     * whole cache file, which costs about as much as linting a file from
     * scratch — and a cached file costs almost nothing. So a batch is sized
     * by time, not by count: it grows while batches finish early (cache hits)
     * and shrinks when they run long.
     */
    batch: {
        /**
         * What a batch should take, ms. Stays under the governor's own
         * reaction time, so the safeguard still lands its decisions in time.
         */
        target: 1500,
        /** Files per batch at most. */
        max: 256,
        /** How much a batch may grow from one to the next. */
        growth: 4,
    },
}

/** Warm workers. */
export const warm = {
    /**
     * How long a warm worker waits for a client before it exits, ms. By
     * default the workers outlive the run and the next run adopts them,
     * skipping the config load and keeping every in-process cache (import-x's
     * export maps above all) warm.
     */
    idle: 30 * 60 * 1000,
    /**
     * How long a one-shot worker whose client vanished — killed outright,
     * not shut down — waits before it reaps itself, ms.
     */
    orphan: 60 * 1000,
    /**
     * What the warm workers may hold between runs, as a share of the memory
     * budget. The warmth is memory — export maps, parser caches — and it
     * grows with every module a worker has seen, so an idle worker past its
     * share exits instead of sleeping on it; the next run forks a fresh one.
     */
    share: 0.6,
    /**
     * How long after its release a worker's size is judged, ms. V8 hands
     * pages back to the machine only once the process has been idle for a
     * while — right after a job every worker looks fat.
     */
    trim: 10000,
    /**
     * How long the parent waits for a fresh worker to answer, ms. A worker
     * listens before it loads anything, so it answers within milliseconds;
     * this only catches one that failed to start at all.
     */
    connect: 15000,
    /** How long to wait for a socket file that may have nobody behind it, ms. */
    probe: 1000,
}
