// Times eslint, eslint --cache, eslint --concurrency=auto and concurrent-eslint
// in cold and warm variants inside a corpus. Usage:
//   node bench/run.mjs <corpus> [runs=3] [label]
// The corpus needs a node_modules with eslint (a symlink to this repository's
// is enough). Prints one line per scenario to stderr and JSON to stdout.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

/** Corpus directory, run count and a label for the report, from argv. */
const [, , corpus, runsArg, label = path.basename(process.argv[2] ?? "")] = process.argv
/** Runs per scenario; the median is reported. */
const runs = Number(runsArg ?? 3)
/** This repository. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
/** The eslint binary from this repository's dependencies. */
const eslint = path.join(root, "node_modules", ".bin", "eslint")
/** The built CLI. */
const cli = path.join(root, "dist", "cli.js")
/** Environment for every run: no color, not CI (so warm workers are allowed). */
const env = {
    ...process.env,
    /** Unset, so warm workers are allowed. */
    CI: undefined,
    /** No color in the captured output. */
    NO_COLOR: "1",
    /** Not even when a library insists. */
    FORCE_COLOR: "0",
}

/** Run a command in the corpus, output captured. */
const sh = (cmd, args) => spawnSync(cmd, args, { cwd: corpus, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 })

/** Wall clock and CPU of one invocation via /usr/bin/time; detached warm workers are not counted. */
const timed = (cmd, args) => {
    const r = spawnSync("/usr/bin/time", ["-f", "%e %U %S", cmd, ...args], { cwd: corpus, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 })
    const [wall, user, sys] = r.stderr.trim().split("\n").at(-1).split(" ").map(Number)
    const out = r.stdout + r.stderr
    const counts = /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(out) ?? /[✖⚠] (\d+) problems?\s+(\d+) errors?\s+(\d+) warnings?/.exec(out)

    return { wall, cpu: user + sys, problems: counts ? `${counts[2]}e/${counts[3]}w` : (/clean/.test(out) ? "0e/0w" : "?"), status: r.status }
}

/** The middle value. */
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

/** Drop every cache and stop every warm worker. */
const reset = () => {
    fs.rmSync(path.join(corpus, ".eslintcache"), { force: true })
    fs.rmSync(path.join(corpus, ".eslintcache-concurrent"), { recursive: true, force: true })
    sh("node", [cli, "--stop-daemon"])
}

/** Scenarios: `before` prepares the state, `warm` ones keep it between runs. */
const scenarios = [
    { name: "eslint", cmd: eslint, args: ["."], before: reset },
    { name: "eslint --cache (warm)", cmd: eslint, args: [".", "--cache"], warm: true, before: () => { reset(); sh(eslint, [".", "--cache"]) } },
    { name: "eslint --concurrency=auto", cmd: eslint, args: [".", "--concurrency=auto"], before: reset },
    { name: "eslint --concurrency=auto --cache (warm)", cmd: eslint, args: [".", "--concurrency=auto", "--cache"], warm: true, before: () => { reset(); sh(eslint, [".", "--concurrency=auto", "--cache"]) } },
    { name: "concurrent-eslint --no-daemon", cmd: "node", args: [cli, "--headless", "--no-daemon"], before: reset },
    { name: "concurrent-eslint --no-daemon --cache (warm)", cmd: "node", args: [cli, "--headless", "--no-daemon", "--cache"], warm: true, before: () => { reset(); sh("node", [cli, "--headless", "--no-daemon", "--cache"]) } },
    { name: "concurrent-eslint (warm workers)", cmd: "node", args: [cli, "--headless", "--daemon"], warm: true, before: () => { reset(); sh("node", [cli, "--headless", "--daemon"]) } },
    { name: "concurrent-eslint --cache (warm workers + cache)", cmd: "node", args: [cli, "--headless", "--daemon", "--cache"], warm: true, before: () => { reset(); sh("node", [cli, "--headless", "--daemon", "--cache"]) } },
]

/** One result row per scenario. */
const rows = []

for (const scenario of scenarios) {
    const samples = []

    for (let i = 0; i < runs; i++) {
        if (i === 0 || !scenario.warm) {
            scenario.before()
        }

        samples.push(timed(scenario.cmd, scenario.args))
    }

    const row = {
        name: scenario.name,
        wall: median(samples.map((s) => s.wall)),
        min: Math.min(...samples.map((s) => s.wall)),
        cpu: median(samples.map((s) => s.cpu)),
        problems: samples[0].problems,
        status: samples[0].status,
    }

    rows.push(row)
    process.stderr.write(`${label}  ${row.name.padEnd(48)} ${row.wall.toFixed(2)}s (min ${row.min.toFixed(2)}) cpu ${row.cpu.toFixed(1)}s ${row.problems} exit ${row.status}\n`)
}

reset()
process.stdout.write(`${JSON.stringify({ label, corpus, runs, rows }, null, 2)}\n`)
