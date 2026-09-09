/**
 * The safeguard. Every `guard.interval` it samples CPU and memory usage
 * and moves the ceiling on concurrently running workers so the machine
 * stays under both thresholds. Gentle on the way up, abrupt on the way down.
 */

import { guard } from "../constants.ts"
import { machine } from "./resources.ts"

/** The safeguard: samples the machine and sets how many workers may run. */
export class Governor implements System.GovernorState {
    /** Hard ceiling on the number of worker slots. */
    readonly max: number
    /** CPU budget as a fraction [0..1]. */
    readonly cpuLimit: number
    /** Memory budget as a fraction [0..1]. */
    readonly memoryLimit: number
    /** With the safeguard off the limit is pinned at max. */
    readonly enabled: boolean
    /**
     * The size the CPU budget is expected to support. The pool starts here
     * and never climbs past it: every oscillation observed in practice began
     * with a ramp above this level, and the thrash cost more than the extra
     * worker ever returned. Above it the governor only ever sheds.
     */
    base: number
    /** How many workers may run at once. */
    limit: number
    /** Smoothed CPU usage [0..1]. */
    cpu = 0
    /** Last raw CPU sample [0..1]. */
    instant = 0
    /** Last memory sample [0..1]. */
    memory: number
    /** Consecutive samples over the CPU budget. */
    over = 0
    /** Consecutive samples over the memory budget. */
    tight = 0
    /** When the limit last moved. */
    adjusted = 0
    /**
     * Near the physical ceiling the pool stops taking work and waits for
     * memory to come back, instead of shrinking itself for good.
     */
    holding = false
    /** When the hold began. */
    held = 0
    /** A hold ran out of patience and the run went ahead anyway. */
    expired = false
    /** No new hold before this time. */
    blocked = 0
    /** The last sample was over the memory budget. */
    pressure = false
    /** The limit is below the sized pool. */
    throttled = false
    /** CPU counters at the last sample. */
    private previous: System.CpuTimes
    /** The sampling interval, while running. */
    private timer: NodeJS.Timeout | null = null
    /** How many workers are busy right now. */
    private readonly active?: () => number
    /** True while workers are still loading their config. */
    private readonly settling?: () => boolean
    /** Our own share of the machine's memory [0..1]. */
    private readonly share?: () => number

    /** Sized from the options; takes its first readings at once. */
    constructor({ max, base, cpuLimit, memoryLimit, enabled, active, settling, share }: System.GovernorOptions) {
        this.max = max
        this.active = active
        this.settling = settling
        this.share = share
        this.cpuLimit = cpuLimit
        this.memoryLimit = memoryLimit
        this.enabled = enabled
        this.base = Math.max(1, Math.min(max, base))
        this.limit = enabled ? this.base : max
        this.memory = machine.usage()
        this.previous = machine.cpu()
    }

    /**
     * Enter the hold when memory crosses the physical threshold, leave it once
     * there is real headroom again. Hysteresis on both edges so one sample
     * cannot flap the pool, and a deadline so a machine that never frees memory
     * does not stall the run forever.
     */
    private hold(): void {
        if (!this.enabled) {
            return
        }

        const enter = Math.min(0.97, this.memoryLimit + guard.ram.hold)
        const leave = this.memoryLimit - guard.ram.margin
        const now = Date.now()

        if (!this.holding && this.memory >= enter && now >= this.blocked) {
            this.holding = true
            this.held = now
            this.trace("hold")
        } else if (this.holding && this.memory <= leave) {
            this.holding = false
            this.trace("resume")
        } else if (this.holding && now - this.held > guard.ram.wait) {
            // The memory never came back, so it was probably never ours to wait
            // for. Go ahead — but do not re-enter the hold straight away, or the
            // run just alternates between waiting and expiring and never moves.
            this.holding = false
            this.expired = true
            this.blocked = now + guard.ram.wait
            // Tight machine, so proceed at the floor rather than at full width.
            this.limit = Math.min(this.limit, guard.ram.floor)
            this.trace("hold/expired")
        }
    }

    /** Take one reading and move the limit if it has to move. */
    sample(): void {
        const current = machine.cpu()
        const idle = current.idle - this.previous.idle
        const total = current.total - this.previous.total

        this.previous = current

        if (total > 0) {
            const busy = Math.min(1, Math.max(0, 1 - idle / total))

            this.instant = busy
            // Exponential smoothing so we don't twitch on momentary spikes.
            // Weighted for roughly a two-second window: a single busy sample must
            // not be able to move the limit on its own.
            this.cpu = this.cpu === 0 ? busy : this.cpu * 0.7 + busy * 0.3
        }

        this.memory = machine.usage()
        this.pressure = this.memory > this.memoryLimit
        this.tight = this.pressure ? this.tight + 1 : 0
        this.hold()

        // While holding, the limit is irrelevant — nothing is being dispatched.
        if (!this.enabled || this.holding) {
            return
        }

        const now = Date.now()
        // The instant sample is noisy — a worker loading its config pins a core
        // for a moment — so it only counts when the box is genuinely pinned.
        const pinned = this.instant > guard.emergency.cpu
        const emergency = this.pressure || pinned

        if (now - this.adjusted < (emergency ? guard.emergency.cooldown : guard.cooldown)) {
            return
        }

        // Cost of one worker, measured rather than assumed. Attributing all
        // system CPU to our workers overestimates it slightly, which errs toward
        // fewer workers — the safe direction.
        const active = Math.max(1, this.active?.() ?? this.limit)
        const each = this.cpu > 0 ? this.cpu / active : 0
        const overBudget = this.cpu > this.cpuLimit

        this.over = overBudget ? this.over + 1 : 0

        // A percent or two over target is measurement noise, and reacting to it
        // is what makes the pool oscillate — which costs more than the overshoot.
        const shed = this.cpu > this.cpuLimit + guard.margin.down || this.over >= guard.windows

        // Shrinking helps only if the memory is ours. On a machine that is full
        // of a browser and an IDE, starving our own pool frees nothing and just
        // makes the run crawl.
        const ours = (this.share?.() ?? 1) > this.memoryLimit * 0.4

        if (this.pressure && ours && this.tight >= guard.ram.windows && this.limit > guard.ram.floor) {
            // Only after recycling has had several windows to help, and never below
            // the floor: a one-worker pool lints more files per process, which is
            // exactly what drove the memory up.
            this.limit = Math.max(guard.ram.floor, this.limit - 1)
            this.adjusted = now
            this.trace("down/mem")
        } else if (pinned || (overBudget && shed)) {
            // Step straight to what the budget affords rather than shedding one
            // worker per cycle: at this cadence, walking down takes most of a run.
            const target = each > 0 ? Math.floor(this.cpuLimit / each) : this.limit - 1

            this.limit = Math.max(1, Math.min(this.limit - 1, target))
            this.over = 0
            this.tight = 0
            this.adjusted = now
            this.trace("down/cpu")
        } else if (
            // Recovery only: back towards the sized pool, never beyond it.
            this.limit < this.base
            && this.cpu < this.cpuLimit - guard.margin.up
            && this.memory < this.memoryLimit - guard.ram.margin
            // A worker still loading its config burns almost nothing, so the
            // headroom we can see right now is not headroom we will keep.
            && !this.settling?.()
        ) {
            this.limit += 1
            this.adjusted = now
            this.trace("up")
        }

        this.throttled = this.limit < this.base
    }

    /** Lower the pool to what the amount of work actually justifies. */
    cap(workers: number): void {
        this.base = Math.max(1, Math.min(this.base, workers))
        this.limit = Math.min(this.limit, this.base)
    }

    /**
     * Called when the pool switches from warming up to real work. The smoothed
     * CPU still describes an idle machine at that moment, so without this the
     * first decisions ramp the pool up on headroom that is already gone.
     */
    settle(): void {
        this.cpu = 0
        this.instant = 0
        this.over = 0
        this.tight = 0
        this.adjusted = Date.now()
    }

    /** Log a decision to stderr under CE_DEBUG=1. */
    private trace(action: string): void {
        if (process.env.CE_DEBUG === "1") {
            process.stderr.write(`[gov] ${action} limit=${this.limit}/${this.max} cpu=${Math.round(this.cpu * 100)}% mem=${Math.round(this.memory * 100)}%\n`)
        }
    }

    /** Sample every `guard.interval`, calling `tick` after each sample. */
    start(tick?: () => void): void {
        this.timer = setInterval(() => {
            this.sample()
            tick?.()
        }, guard.interval)
    }

    /** Stop sampling. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }
}
