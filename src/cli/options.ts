/**
 * Command-line parsing. Throws on anything it does not understand; the
 * caller prints the message and exits with 2.
 */

import { guard } from "../constants.ts"
import { machine, ram } from "../system/resources.ts"

/** Command-line parsing. */
export const args = {
    /** A percentage argument, 5..100. */
    percent(raw: string, name: string): number {
        const value = Number.parseInt(raw, 10)

        if (!Number.isInteger(value) || value < 5 || value > 100) {
            throw new Error(`${name} must be an integer between 5 and 100`)
        }

        return value
    },

    /** A --cache-strategy argument. */
    strategy(raw: string): Cli.CacheStrategy {
        if (raw !== "metadata" && raw !== "content") {
            throw new Error("--cache-strategy must be metadata or content")
        }

        return raw
    },

    /**
     * Memory can be given as a share ("75", "75%") or as an absolute size
     * ("8G", "8192M"). A bare number meaning "percent" is easy to read as
     * gigabytes, so the absolute form exists and the resolved budget is always
     * echoed back in the header.
     */
    memory(raw: string, name: string, total = ram): number {
        const match = (/^(\d+(?:\.\d+)?)\s*(%|g|gb|m|mb)?$/i).exec(String(raw ?? "").trim())

        if (!match) {
            throw new Error(`${name}: expected a percentage (75, 75%) or a size (8G, 8192M)`)
        }

        const amount = Number.parseFloat(match[1])
        const unit = (match[2] || "%").toLowerCase()

        if (unit === "%") {
            return this.percent(match[1], name)
        }

        const bytes = unit.startsWith("g") ? amount * 1024 ** 3 : amount * 1024 ** 2
        const share = Math.round((bytes / total) * 100)

        if (share < 5 || share > 100) {
            throw new Error(`${name}: ${raw} is ${share}% of this machine's ${(total / 1024 ** 3).toFixed(1)}G — allowed range is 5-100%`)
        }

        return share
    },

    /** Parse argv into options. Throws on anything it does not understand. */
    parse(argv: string[], environment: Cli.Environment = { isTTY: process.stdout.isTTY === true, env: process.env }): Cli.Options {
        const cores = machine.cores()
        // Warm workers are for a developer's machine; a CI job has no next run
        // to hand them to, and a lingering process on a shared runner is a leak.
        let daemon: boolean | null = null
        const options: Cli.Options = {
            threads: cores * 2,
            fix: false,
            quiet: false,
            cache: false,
            cacheStrategy: "content",
            maxWarnings: -1,
            maxCpu: guard.cpu,
            maxMemory: guard.memory,
            safeguard: true,
            headless: false,
            changed: false,
            since: null,
            daemon: false,
            stopDaemon: false,
            prune: false,
            color: environment.isTTY && environment.env.NO_COLOR === undefined,
            paths: [],
            help: false,
        }

        const at = (index: number): string => argv[index] ?? ""

        for (let index = 0; index < argv.length; index++) {
            const arg = argv[index]

            if (arg === "-h" || arg === "--help") {
                options.help = true
            } else if (arg === "-t" || arg === "--threads") {
                options.threads = Number.parseInt(at(++index), 10)
            } else if (arg.startsWith("--threads=")) {
                options.threads = Number.parseInt(arg.slice("--threads=".length), 10)
            } else if (arg === "--max-cpu") {
                options.maxCpu = this.percent(at(++index), "--max-cpu")
            } else if (arg.startsWith("--max-cpu=")) {
                options.maxCpu = this.percent(arg.slice("--max-cpu=".length), "--max-cpu")
            } else if (arg === "--max-memory") {
                options.maxMemory = this.memory(at(++index), "--max-memory")
            } else if (arg.startsWith("--max-memory=")) {
                options.maxMemory = this.memory(arg.slice("--max-memory=".length), "--max-memory")
            } else if (arg === "--no-safeguard") {
                options.safeguard = false
            } else if (arg === "--headless") {
                options.headless = true
            } else if (arg === "--daemon") {
                daemon = true
            } else if (arg === "--no-daemon") {
                daemon = false
            } else if (arg === "--stop-daemon") {
                options.stopDaemon = true
            } else if (arg === "--prune") {
                options.stopDaemon = true
                options.prune = true
            } else if (arg === "--changed") {
                options.changed = true
            } else if (arg === "--since") {
                options.since = at(++index)
                options.changed = true
            } else if (arg.startsWith("--since=")) {
                options.since = arg.slice("--since=".length)
                options.changed = true
            } else if (arg === "--fix") {
                options.fix = true
            } else if (arg === "--quiet") {
                options.quiet = true
            } else if (arg === "--cache") {
                options.cache = true
            } else if (arg === "--no-cache") {
                options.cache = false
            } else if (arg === "--cache-strategy") {
                options.cacheStrategy = this.strategy(at(++index))
            } else if (arg.startsWith("--cache-strategy=")) {
                options.cacheStrategy = this.strategy(arg.slice("--cache-strategy=".length))
            } else if (arg === "--max-warnings") {
                options.maxWarnings = Number.parseInt(at(++index), 10)
            } else if (arg.startsWith("--max-warnings=")) {
                options.maxWarnings = Number.parseInt(arg.slice("--max-warnings=".length), 10)
            } else if (arg === "--color") {
                options.color = true
            } else if (arg === "--no-color") {
                options.color = false
            } else if (arg.startsWith("-")) {
                throw new Error(`Unknown option: ${arg}`)
            } else {
                options.paths.push(arg)
            }
        }

        if (!Number.isInteger(options.threads) || options.threads < 1) {
            throw new Error("--threads must be a positive integer")
        }

        options.daemon = daemon ?? (!options.headless && environment.env.CI === undefined)

        if (options.since !== null && !options.since) {
            throw new Error("--since needs a ref, e.g. --since master")
        }

        return options
    },
}
