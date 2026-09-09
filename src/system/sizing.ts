/**
 * How many workers the machine can run, and how big each may get. Decided
 * once before the run from the budget, not from whatever happens to be free
 * this second.
 */

import { guard, warm } from "../constants.ts"
import { machine, ram } from "./resources.ts"

/** Size the pool for these options. */
export const plan = (options: Cli.Options): System.Plan => {
    const cores = machine.cores()
    const cpuLimit = options.maxCpu / 100
    const memoryLimit = options.maxMemory / 100
    const ceiling = Math.max(1, Math.floor(cores * cpuLimit))
    // What the CPU budget is really expected to support, once a worker is
    // priced at what it actually costs.
    const expected = Math.max(1, Math.round(cores * cpuLimit / guard.cost))
    const requested = options.threads
    const threads = Math.max(1, options.safeguard ? Math.min(requested, ceiling) : requested)

    const budget = ram * memoryLimit
    const available = Math.max(0, budget - ram * machine.usage())
    // How many workers the machine can hold, judged against the budget rather
    // than against whatever happens to be free this second. A browser and an
    // IDE holding half the RAM are not ours to plan around; if they really are
    // in the way, the runtime safeguard holds the pool until they let go.
    const affordable = Math.max(1, Math.floor(budget / (guard.heap.rss * 1024 * 1024)))
    const size = options.safeguard ? Math.max(1, Math.min(expected, affordable)) : threads
    const heap = Math.max(guard.heap.min, Math.min(guard.heap.max, Math.floor(budget / size / (1024 * 1024))))

    return {
        cores,
        cpuLimit,
        memoryLimit,
        threads,
        requested,
        size,
        expected,
        affordable,
        bound: options.safeguard && affordable < expected,
        // Starting with the machine already past the budget is allowed — the
        // pool simply spends its first samples waiting instead of working.
        overcommitted: options.safeguard && available < guard.heap.min * 1024 * 1024,
        budget,
        available,
        totalGb: (ram / 1024 ** 3).toFixed(1),
        budgetGb: (budget / 1024 ** 3).toFixed(1),
        heap,
        // Resident size at which a worker is recycled, so the pool stays inside
        // the budget instead of only reacting once the machine is already tight.
        rssBudget: options.safeguard ? (budget * guard.recycle.headroom) / size : 0,
        idleBudget: Math.floor((budget * warm.share) / size),
    }
}
