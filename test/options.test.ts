import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { args } from "../src/cli/options.ts"

const environment: Cli.Environment = { isTTY: false, env: {} }

describe("args.parse", () => {
    it("has sane defaults", () => {
        const options = args.parse([], environment)

        assert.equal(options.fix, false)
        assert.equal(options.cache, false)
        assert.equal(options.cacheStrategy, "content")
        assert.equal(options.maxWarnings, -1)
        assert.equal(options.safeguard, true)
        assert.equal(options.daemon, true)
        assert.equal(options.color, false)
        assert.deepEqual(options.paths, [])
    })

    it("reads options in both spellings", () => {
        const a = args.parse(["--threads", "3", "--max-cpu", "50", "--max-warnings", "7"], environment)
        const b = args.parse(["--threads=3", "--max-cpu=50", "--max-warnings=7"], environment)

        assert.equal(a.threads, 3)
        assert.equal(a.maxCpu, 50)
        assert.equal(a.maxWarnings, 7)
        assert.deepEqual(a, b)
    })

    it("collects positional paths", () => {
        const options = args.parse(["src", "--fix", "lib"], environment)

        assert.deepEqual(options.paths, ["src", "lib"])
        assert.equal(options.fix, true)
    })

    it("turns the daemon off under CI and --headless", () => {
        assert.equal(args.parse([], { isTTY: false, env: { CI: "1" } }).daemon, false)
        assert.equal(args.parse(["--headless"], environment).daemon, false)
        assert.equal(args.parse(["--headless", "--daemon"], environment).daemon, true)
        assert.equal(args.parse(["--no-daemon"], environment).daemon, false)
    })

    it("implies --changed with --since", () => {
        const options = args.parse(["--since", "main"], environment)

        assert.equal(options.changed, true)
        assert.equal(options.since, "main")
        assert.throws(() => args.parse(["--since"], environment), /--since needs a ref/)
    })

    it("has --prune imply --stop-daemon", () => {
        const options = args.parse(["--prune"], environment)

        assert.equal(options.prune, true)
        assert.equal(options.stopDaemon, true)
    })

    it("rejects bad input", () => {
        assert.throws(() => args.parse(["--bogus"], environment), /Unknown option/)
        assert.throws(() => args.parse(["--threads", "0"], environment), /--threads/)
        assert.throws(() => args.parse(["--max-cpu", "3"], environment), /between 5 and 100/)
        assert.throws(() => args.parse(["--cache-strategy", "x"], environment), /metadata or content/)
    })
})

describe("args.memory", () => {
    const machine = 16 * 1024 ** 3

    it("accepts a percentage", () => {
        assert.equal(args.memory("75", "--max-memory", machine), 75)
        assert.equal(args.memory("50%", "--max-memory", machine), 50)
    })

    it("converts an absolute size", () => {
        assert.equal(args.memory("8G", "--max-memory", machine), 50)
        assert.equal(args.memory("4096M", "--max-memory", machine), 25)
        assert.equal(args.memory("1.6gb", "--max-memory", machine), 10)
    })

    it("rejects sizes outside the range", () => {
        assert.throws(() => args.memory("32G", "--max-memory", machine), /allowed range/)
        assert.throws(() => args.memory("lots", "--max-memory", machine), /expected a percentage/)
    })
})
