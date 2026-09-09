/**
 * Fresh worker slots and totals.
 */

export const slot = (index: number): Workers.Slot => ({
    index,
    assigned: 0,
    done: 0,
    errors: 0,
    warnings: 0,
    current: "",
    state: "cold",
    started: false,
    stolen: 0,
    reassigned: 0,
    fixed: 0,
    lines: 0,
    queue: [],
    flight: [],
    batch: 0,
    count: 0,
    since: 0,
    child: null,
    recycle: false,
    recycled: 0,
    rss: 0,
    mark: 0,
})

/** Fresh totals, everything at zero. */
export const totals = (): Workers.Totals => ({
    errors: 0,
    warnings: 0,
    fixableErrors: 0,
    fixableWarnings: 0,
    problematic: 0,
    fixed: 0,
    lines: 0,
    parked: 0,
    killed: 0,
    recycled: 0,
    oom: 0,
    rebalanced: 0,
    ignored: 0,
    adopted: 0,
    rss: 0,
    held: 0,
    peakRss: 0,
    peakMemory: 0,
    crashes: [],
    failures: [],
})
