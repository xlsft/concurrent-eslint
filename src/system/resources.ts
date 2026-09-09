/**
 * What the machine has and how much of it is in use. Honours cgroup limits
 * so a container sees its quota, not the host.
 */

import fs from "node:fs"
import os from "node:os"

/** The machine's resources, read live. */
export const machine = {
    /** A number from a one-line file, or null. */
    read(file: string): number | null {
        try {
            const value = Number.parseFloat(fs.readFileSync(file, "utf8").trim())

            return Number.isFinite(value) ? value : null
        } catch {
            return null
        }
    },

    /** Cores actually available to us (honours a cgroup quota in a container). */
    cores(): number {
        const cores = Math.max(1, os.cpus().length || 1)

        try {
            const [quota, period] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/)

            if (quota !== "max") {
                const limited = Number(quota) / Number(period)

                if (Number.isFinite(limited) && limited >= 1) {
                    return Math.min(cores, Math.floor(limited))
                }
            }
        } catch {
            // No cgroup v2 — fall back to v1
        }

        const quota = this.read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        const period = this.read("/sys/fs/cgroup/cpu/cpu.cfs_period_us")

        if (quota && quota > 0 && period && period > 0) {
            return Math.max(1, Math.min(cores, Math.floor(quota / period)))
        }

        return cores
    },

    /** Memory ceiling: the cgroup limit when sane, otherwise the whole machine. */
    limit(): number {
        const total = os.totalmem()
        const candidates = [
            this.read("/sys/fs/cgroup/memory.max"),
            this.read("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
        ]

        for (const candidate of candidates) {
            if (candidate && candidate > 0 && candidate < total) {
                return candidate
            }
        }

        return total
    },

    /** Fraction of memory in use [0..1]. On Linux via MemAvailable / cgroup. */
    usage(): number {
        const current = this.read("/sys/fs/cgroup/memory.current")
            ?? this.read("/sys/fs/cgroup/memory/memory.usage_in_bytes")

        if (current !== null && ram < os.totalmem()) {
            return Math.min(1, current / ram)
        }

        try {
            const meminfo = fs.readFileSync("/proc/meminfo", "utf8")
            const available = (/^MemAvailable:\s+(\d+) kB$/m).exec(meminfo)

            if (available) {
                return Math.min(1, Math.max(0, 1 - (Number(available[1]) * 1024) / ram))
            }
        } catch {
            // Not Linux — fall back to os.freemem()
        }

        return Math.min(1, Math.max(0, 1 - os.freemem() / ram))
    },

    /** Resident size of a process, in bytes. Linux only; 0 when unavailable. */
    rss(pid: number): number {
        try {
            // statm: size resident shared text lib data dt — we want the second field.
            const resident = Number(fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1])

            return Number.isFinite(resident) ? resident * 4096 : 0
        } catch {
            return 0
        }
    },

    /** CPU time counters since boot, summed over every core. */
    cpu(): System.CpuTimes {
        let idle = 0
        let total = 0

        for (const cpu of os.cpus()) {
            for (const [kind, value] of Object.entries(cpu.times)) {
                total += value

                if (kind === "idle") {
                    idle += value
                }
            }
        }

        return { idle, total }
    },
}

/** The memory ceiling, bytes. Fixed for the life of the process. */
export const ram = machine.limit()
