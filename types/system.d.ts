/**
 * Machine resources, the safeguard and pool sizing.
 * Ambient — available everywhere without an import.
 */
declare namespace System {
    /** CPU time counters, summed over every core. */
    interface CpuTimes {
        /** Ticks spent idle. */
        idle: number
        /** Ticks in every state, idle included. */
        total: number
    }

    /** What the safeguard is told about the pool. */
    interface GovernorOptions {
        /** Hard ceiling on the number of worker slots. */
        max: number
        /** The size the CPU budget is expected to support. */
        base: number
        /** CPU budget as a fraction [0..1]. */
        cpuLimit: number
        /** Memory budget as a fraction [0..1]. */
        memoryLimit: number
        /** With the safeguard off the limit is pinned at max. */
        enabled: boolean
        /** How many workers are busy right now. */
        active?: () => number
        /** True while workers are still loading their config. */
        settling?: () => boolean
        /** Our own share of the machine's memory [0..1]. */
        share?: () => number
    }

    /** What the live view and the summary read off the safeguard. */
    interface GovernorState {
        /** Smoothed CPU usage [0..1]. */
        cpu: number
        /** Last memory sample [0..1]. */
        memory: number
        /** CPU budget as a fraction [0..1]. */
        cpuLimit: number
        /** Memory budget as a fraction [0..1]. */
        memoryLimit: number
        /** How many workers may run at once. */
        limit: number
        /** Nothing is dispatched: waiting for memory to come back. */
        holding: boolean
        /** A hold ran out of patience and the run went ahead anyway. */
        expired: boolean
        /** The limit is below the sized pool. */
        throttled: boolean
    }

    /** How many workers the machine can run, and how big each may get. */
    interface Plan {
        /** Cores available to us. */
        cores: number
        /** CPU budget as a fraction. */
        cpuLimit: number
        /** Memory budget as a fraction. */
        memoryLimit: number
        /** Worker slots — what --threads asked for, capped by the CPU budget. */
        threads: number
        /** What --threads asked for. */
        requested: number
        /** Slots the budget is expected to run at once. */
        size: number
        /** What the CPU budget alone would allow. */
        expected: number
        /** What the memory budget alone would allow. */
        affordable: number
        /** Memory, not CPU, decided the pool size. */
        bound: boolean
        /** The machine is already past the budget before we start. */
        overcommitted: boolean
        /** Memory budget, bytes. */
        budget: number
        /** Of the budget, what is free right now, bytes. */
        available: number
        /** The machine's memory ceiling, in gigabytes, for the header. */
        totalGb: string
        /** The memory budget, in gigabytes, for the header. */
        budgetGb: string
        /** Per-worker heap, MB. */
        heap: number
        /** Resident size at which a worker is recycled; 0 with the safeguard off. */
        rssBudget: number
        /** What an idle warm worker may hold before it exits instead. */
        idleBudget: number
    }
}
