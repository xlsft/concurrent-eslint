#!/usr/bin/env node
"use strict"

/**
 * concurrent-eslint — a multi-process ESLint runner.
 *
 * Globs every file eslint.config.mjs applies to, spreads them across
 * workers and renders live progress in braille. A worker's block turns
 * red if it hit even one error, green otherwise. Errors are printed as
 * soon as they are found.
 *
 * With --cache, results are kept between runs: every worker writes its
 * own ESLint cache file and the parent folds them into one shared file
 * after the run, so a file is a hit whichever worker gets it next time.
 *
 * Safeguard: the tool refuses to eat the machine — it keeps CPU and
 * memory usage under a threshold (75% by default) by parking surplus
 * workers, and killing them outright when memory runs short.
 *
 *   node concurrent-eslint.js [paths...] [options]
 */

const childProcess = require("node:child_process")
const crypto = require("node:crypto")
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

const ESC = "\u001B"
const RESET = `${ESC}[0m`

// A braille cell fills bottom-up: left column first, then right.
// That gives 8 sub-steps per character, so the bar moves smoothly.
const BAR_CELLS = ["⠀", "⡀", "⡄", "⡆", "⡇", "⣇", "⣧", "⣷", "⣿"]
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const DONE_MARK = "⣿"
const PARKED_MARK = "⠶"
const COLD_MARK = "⠈"
const BAR_WIDTH = 12
const SUBSTEPS = BAR_CELLS.length - 1

const DEFAULT_EXTENSIONS = ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue"]
const CACHE_DIR = ".eslintcache-concurrent"
const CACHE_FILE = "cache.json"
const HARD_SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".nuxt", ".output", ".nitro",
  ".cache", ".data", "dist", "coverage", ".yarn", ".pnpm-store",
])

/* Safeguard */
const DEFAULT_MAX_CPU = 75
const DEFAULT_MAX_MEMORY = 75
const SAMPLE_INTERVAL = 500
// Parking only takes effect once a worker finishes its current batch, so a
// decision needs seconds to show up in the samples. Re-deciding faster than
// that just stacks corrections on top of each other and makes the pool
// oscillate, so both directions wait out the actuation delay.
const ADJUST_COOLDOWN = 3000
// Memory pressure and a genuinely pinned CPU can't wait that long.
const EMERGENCY_COOLDOWN = 1000
const EMERGENCY_CPU = 0.92
// No integer worker count lands exactly on the CPU target, so the pool sits
// slightly under it or slightly over. Both edges get a margin, or it hunts
// between two levels forever — and the hunting itself burns more CPU than
// the level above would have.
const UP_MARGIN = 0.12
const DOWN_MARGIN = 0.06
// Short bursts above target are normal — the pool sheds only on a real spike
// or on an overshoot that persists across this many windows. Reacting to
// every peak costs more, in CPU and in wall clock, than the peak itself.
const OVER_WINDOWS = 3
const SPAWN_INTERVAL = 700
// A lint worker is not one core's worth of work: V8 runs GC and compilation
// on background threads, so a busy worker measures at roughly this many
// cores. Sizing the pool as cores/1 overshoots the CPU budget, and the
// governor then spends the whole run shedding what it just added.
const WORKER_CPU_COST = 1.35
// A worker spends a few seconds loading the config before it lints anything,
// so below roughly this many files an extra worker costs more than it saves.
const FILES_PER_WORKER = 25
// A worker's footprint grows the whole time it lints — ESLint holds on to
// parsed state between calls — so a long-lived worker is a slow leak. Past
// its share of the memory budget it gets recycled: killed between batches
// and started again with its queue intact.
const RECYCLE_HEADROOM = 0.8
// Memory pressure has to persist this long before the pool itself shrinks.
// Shrinking is the wrong answer to our own growth (fewer workers means one
// worker lints more files and grows further), so recycling comes first.
const MEMORY_WINDOWS = 4
// Never starve the pool down to a single worker on memory alone.
const MEMORY_FLOOR = 2
// Hysteresis on the memory side of the ramp-up decision. Small on purpose:
// a wide margin does not damp anything, it just makes memory usage well
// below the limit silently prevent the pool from ever growing.
const MEMORY_UP_MARGIN = 0.03
// Recycling costs a full config load, so it is rate-limited hard. Without
// this, sustained pressure marks a worker on every sample and the pool
// spends the whole run restarting instead of linting.
const RECYCLE_COOLDOWN = 20000
// And a worker has to have done enough work to be worth the restart.
const RECYCLE_MIN_FILES = 100
// A worker with less heap than this does not run slower — it dies. Sizing
// the heap by "budget / slots" is what produced 1.3 GB workers on a 16 GB
// box and an OOM loop; if the budget cannot afford this much per worker,
// the answer is fewer workers, never a smaller heap.
const MIN_VIABLE_HEAP_MB = 2048
const MAX_WORKER_HEAP_MB = 4096
// A worker killed by the heap limit gets a bigger one on the way back.
const HEAP_BUMP = 1.5
// What a worker actually resides at, as opposed to the heap ceiling it is
// allowed to reach. Sizing the pool against the ceiling assumes every worker
// instantly claims its cap — roughly double what they really take.
const WORKER_RSS_ESTIMATE_MB = 1536
// Past this the pool stops taking new work and waits for memory to come back
// instead of shrinking itself for good.
const MEMORY_HOLD_MARGIN = 0.05
// Waiting forever is worse than overshooting: if the memory was never ours it
// may never come back, so the hold gives up after this long.
const MAX_HOLD_MS = 90000
// How many times a file that killed a worker is retried before giving up.
const MAX_ATTEMPTS = 2
// Every lintFiles() call ends with ESLint rewriting its whole cache file,
// which costs about as much as linting a file from scratch — and a cached
// file costs almost nothing. So a batch is sized by time, not by count: it
// grows while batches finish early (cache hits) and shrinks when they run
// long. The target stays under the governor's own reaction time, so the
// safeguard still lands its decisions in time.
const BATCH_TARGET_MS = 1500
const MAX_BATCH = 256
const BATCH_GROWTH = 4
// By default the workers outlive the run and the next run adopts them,
// skipping the config load and keeping every in-process cache (import-x's
// export maps above all) warm. They leave on their own after this long
// without a client.
const DAEMON_IDLE_MS = 30 * 60 * 1000
// A one-shot worker whose client vanished — killed outright, not shut
// down — reaps itself after this long instead of lingering.
const ORPHAN_IDLE_MS = 60 * 1000
// What the warm workers may hold between runs, as a share of the memory
// budget. The warmth is memory — export maps, parser caches — and it grows
// with every module a worker has seen, so an idle worker past its share
// exits instead of sleeping on it; the next run forks a fresh one.
const DAEMON_IDLE_SHARE = 0.6
// V8 hands pages back to the machine only once the process has been idle
// for a while, so a worker's size is judged this long after its release,
// not at the moment of it — right after a job every worker looks fat.
const TRIM_DELAY_MS = 10000
// A worker listens before it loads anything, so it answers within
// milliseconds; this only catches one that failed to start at all.
const CONNECT_TIMEOUT_MS = 15000
// A socket file with nobody behind it is a leftover of a dead worker.
const PROBE_TIMEOUT_MS = 1000

/* ------------------------------------------------------------------ */
/* Colors                                                              */
/* ------------------------------------------------------------------ */

function createPalette(enabled) {
  const wrap = (open, close) => (text) => (enabled ? `${ESC}[${open}m${text}${ESC}[${close}m` : String(text))

  return {
    enabled,
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
    gray: wrap(90, 39),
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    underline: wrap(4, 24),
  }
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g")

function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, "")
}

function visibleLength(text) {
  return stripAnsi(text).length
}

/** Truncate by visible characters, keeping ANSI sequences intact. */
function truncate(text, limit) {
  if (limit <= 0) {
    return ""
  }

  const source = String(text)

  if (visibleLength(source) <= limit) {
    return source
  }

  let out = ""
  let visible = 0
  let index = 0

  while (index < source.length && visible < limit - 1) {
    if (source[index] === ESC) {
      const end = source.indexOf("m", index)

      if (end === -1) {
        break
      }

      out += source.slice(index, end + 1)
      index = end + 1
      continue
    }

    out += source[index]
    visible += 1
    index += 1
  }

  return `${out}…`
}

function padEnd(text, width) {
  const diff = width - visibleLength(text)

  return diff > 0 ? `${text}${" ".repeat(diff)}` : String(text)
}

function padStart(text, width) {
  const diff = width - visibleLength(text)

  return diff > 0 ? `${" ".repeat(diff)}${text}` : String(text)
}

/** "1 file" / "2 files" — counts show up all over the summary. */
function plural(count, singular, many = `${singular}s`) {
  return `${count} ${count === 1 ? singular : many}`
}

/* ------------------------------------------------------------------ */
/* Braille progress bar                                                */
/* ------------------------------------------------------------------ */

function brailleBar(done, total, width = BAR_WIDTH) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0
  const filled = Math.round(ratio * width * SUBSTEPS)
  let bar = ""

  for (let cell = 0; cell < width; cell++) {
    const level = Math.min(SUBSTEPS, Math.max(0, filled - cell * SUBSTEPS))

    bar += BAR_CELLS[level]
  }

  return bar
}

/* ------------------------------------------------------------------ */
/* Machine resources                                                   */
/* ------------------------------------------------------------------ */

function readNumber(file) {
  try {
    const value = Number.parseFloat(fs.readFileSync(file, "utf8").trim())

    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/** Cores actually available to us (honours a cgroup quota in a container). */
function effectiveCores() {
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

  const quota = readNumber("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
  const period = readNumber("/sys/fs/cgroup/cpu/cpu.cfs_period_us")

  if (quota && quota > 0 && period && period > 0) {
    return Math.max(1, Math.min(cores, Math.floor(quota / period)))
  }

  return cores
}

/** Memory ceiling: the cgroup limit when sane, otherwise the whole machine. */
function memoryLimitBytes() {
  const total = os.totalmem()
  const candidates = [
    readNumber("/sys/fs/cgroup/memory.max"),
    readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
  ]

  for (const candidate of candidates) {
    if (candidate && candidate > 0 && candidate < total) {
      return candidate
    }
  }

  return total
}

const MEMORY_LIMIT = memoryLimitBytes()

/** Fraction of memory in use [0..1]. On Linux via MemAvailable / cgroup. */
function memoryUsage() {
  const cgroupCurrent = readNumber("/sys/fs/cgroup/memory.current")
    ?? readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes")

  if (cgroupCurrent !== null && MEMORY_LIMIT < os.totalmem()) {
    return Math.min(1, cgroupCurrent / MEMORY_LIMIT)
  }

  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8")
    const available = (/^MemAvailable:\s+(\d+) kB$/m).exec(meminfo)

    if (available) {
      return Math.min(1, Math.max(0, 1 - (Number(available[1]) * 1024) / MEMORY_LIMIT))
    }
  } catch {
    // Not Linux — fall back to os.freemem()
  }

  return Math.min(1, Math.max(0, 1 - os.freemem() / MEMORY_LIMIT))
}

/** Resident size of a process, in bytes. Linux only; 0 when unavailable. */
function processRss(pid) {
  try {
    // statm: size resident shared text lib data dt — we want the second field.
    const resident = Number(fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1])

    return Number.isFinite(resident) ? resident * 4096 : 0
  } catch {
    return 0
  }
}

function cpuTimes() {
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
}

/**
 * The safeguard. Every SAMPLE_INTERVAL it samples CPU and memory usage
 * and moves the ceiling on concurrently running workers so the machine
 * stays under both thresholds. Gentle on the way up, abrupt on the way down.
 */
class Governor {
  constructor({ maxWorkers, startAt, cpuLimit, memoryLimit, enabled, getActive, isSettling, getOurShare }) {
    this.maxWorkers = maxWorkers
    this.getActive = getActive
    this.isSettling = isSettling
    this.getOurShare = getOurShare
    this.overCount = 0
    this.memoryCount = 0
    this.cpuLimit = cpuLimit
    this.memoryLimit = memoryLimit
    this.enabled = enabled
    // The size the CPU budget is expected to support. The pool starts here
    // and never climbs past it: every oscillation observed in practice began
    // with a ramp above this level, and the thrash cost more than the extra
    // worker ever returned. Above it the governor only ever sheds.
    this.startAt = Math.max(1, Math.min(maxWorkers, startAt))
    this.limit = enabled ? this.startAt : maxWorkers
    this.cpu = 0
    this.instant = 0
    this.memory = memoryUsage()
    this.previous = cpuTimes()
    this.lastAdjust = 0
    // Near the physical ceiling the pool stops taking work and waits for
    // memory to come back, instead of shrinking itself for good.
    this.holding = false
    this.holdSince = 0
    this.holdExpired = false
    this.holdBlockedUntil = 0
    this.memoryPressure = false
    this.throttled = false
    this.timer = null
  }

  /**
   * Enter the hold when memory crosses the physical threshold, leave it once
   * there is real headroom again. Hysteresis on both edges so one sample
   * cannot flap the pool, and a deadline so a machine that never frees memory
   * does not stall the run forever.
   */
  updateHold() {
    if (!this.enabled) {
      return
    }

    const holdAt = Math.min(0.97, this.memoryLimit + MEMORY_HOLD_MARGIN)
    const releaseAt = this.memoryLimit - MEMORY_UP_MARGIN
    const now = Date.now()

    if (!this.holding && this.memory >= holdAt && now >= this.holdBlockedUntil) {
      this.holding = true
      this.holdSince = now
      this.trace("hold")
    } else if (this.holding && this.memory <= releaseAt) {
      this.holding = false
      this.trace("resume")
    } else if (this.holding && now - this.holdSince > MAX_HOLD_MS) {
      // The memory never came back, so it was probably never ours to wait
      // for. Go ahead — but do not re-enter the hold straight away, or the
      // run just alternates between waiting and expiring and never moves.
      this.holding = false
      this.holdExpired = true
      this.holdBlockedUntil = now + MAX_HOLD_MS
      // Tight machine, so proceed at the floor rather than at full width.
      this.limit = Math.min(this.limit, MEMORY_FLOOR)
      this.trace("hold/expired")
    }
  }

  sample() {
    const current = cpuTimes()
    const idleDelta = current.idle - this.previous.idle
    const totalDelta = current.total - this.previous.total

    this.previous = current

    if (totalDelta > 0) {
      const busy = Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))

      this.instant = busy
      // Exponential smoothing so we don't twitch on momentary spikes.
      // Weighted for roughly a two-second window: a single busy sample must
      // not be able to move the limit on its own.
      this.cpu = this.cpu === 0 ? busy : this.cpu * 0.7 + busy * 0.3
    }

    this.memory = memoryUsage()
    this.memoryPressure = this.memory > this.memoryLimit
    this.memoryCount = this.memoryPressure ? this.memoryCount + 1 : 0
    this.updateHold()

    // While holding, the limit is irrelevant — nothing is being dispatched.
    if (!this.enabled || this.holding) {
      return
    }

    const now = Date.now()
    const overMemory = this.memory > this.memoryLimit
    // The instant sample is noisy — a worker loading its config pins a core
    // for a moment — so it only counts when the box is genuinely pinned.
    const pinned = this.instant > EMERGENCY_CPU
    const emergency = overMemory || pinned

    if (now - this.lastAdjust < (emergency ? EMERGENCY_COOLDOWN : ADJUST_COOLDOWN)) {
      return
    }

    // Cost of one worker, measured rather than assumed. Attributing all
    // system CPU to our workers overestimates it slightly, which errs toward
    // fewer workers — the safe direction.
    const active = Math.max(1, this.getActive?.() ?? this.limit)
    const perWorker = this.cpu > 0 ? this.cpu / active : 0

    const overBudget = this.cpu > this.cpuLimit

    this.overCount = overBudget ? this.overCount + 1 : 0

    // A percent or two over target is measurement noise, and reacting to it
    // is what makes the pool oscillate — which costs more than the overshoot.
    const mustShed = this.cpu > this.cpuLimit + DOWN_MARGIN || this.overCount >= OVER_WINDOWS

    // Shrinking helps only if the memory is ours. On a machine that is full
    // of a browser and an IDE, starving our own pool frees nothing and just
    // makes the run crawl.
    const oursMatters = (this.getOurShare?.() ?? 1) > this.memoryLimit * 0.4

    if (overMemory && oursMatters && this.memoryCount >= MEMORY_WINDOWS && this.limit > MEMORY_FLOOR) {
      // Only after recycling has had several windows to help, and never below
      // the floor: a one-worker pool lints more files per process, which is
      // exactly what drove the memory up.
      this.limit = Math.max(MEMORY_FLOOR, this.limit - 1)
      this.lastAdjust = now
      this.trace("down/mem")
    } else if (pinned || (overBudget && mustShed)) {
      // Step straight to what the budget affords rather than shedding one
      // worker per cycle: at this cadence, walking down takes most of a run.
      const target = perWorker > 0 ? Math.floor(this.cpuLimit / perWorker) : this.limit - 1

      this.limit = Math.max(1, Math.min(this.limit - 1, target))
      this.overCount = 0
    this.memoryCount = 0
      this.lastAdjust = now
      this.trace("down/cpu")
    } else if (
      // Recovery only: back towards the sized pool, never beyond it.
      this.limit < this.startAt
      && this.cpu < this.cpuLimit - UP_MARGIN
      && this.memory < this.memoryLimit - MEMORY_UP_MARGIN
      // A worker still loading its config burns almost nothing, so the
      // headroom we can see right now is not headroom we will keep.
      && !this.isSettling?.()
    ) {
      this.limit += 1
      this.lastAdjust = now
      this.trace("up")
    }

    this.throttled = this.limit < this.startAt
  }

  /**
   * Called when the pool switches from warming up to real work. The smoothed
   * CPU still describes an idle machine at that moment, so without this the
   * first decisions ramp the pool up on headroom that is already gone.
   */
  /** Lower the pool to what the amount of work actually justifies. */
  capTo(workers) {
    this.startAt = Math.max(1, Math.min(this.startAt, workers))
    this.limit = Math.min(this.limit, this.startAt)
  }

  settle() {
    this.cpu = 0
    this.instant = 0
    this.overCount = 0
    this.memoryCount = 0
    this.lastAdjust = Date.now()
  }

  trace(action) {
    if (process.env.CE_DEBUG === "1") {
      process.stderr.write(`[gov] ${action} limit=${this.limit}/${this.maxWorkers} cpu=${Math.round(this.cpu * 100)}% mem=${Math.round(this.memory * 100)}%\n`)
    }
  }

  start(onSample) {
    this.timer = setInterval(() => {
      this.sample()
      onSample?.()
    }, SAMPLE_INTERVAL)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

/* ------------------------------------------------------------------ */
/* Argument parsing                                                    */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const cores = effectiveCores()
  const options = {
    threads: cores * 2,
    fix: false,
    quiet: false,
    cache: false,
    cacheStrategy: "content",
    maxWarnings: -1,
    maxCpu: DEFAULT_MAX_CPU,
    maxMemory: DEFAULT_MAX_MEMORY,
    safeguard: true,
    headless: false,
    changed: false,
    since: null,
    // Warm workers are for a developer's machine; a CI job has no next run
    // to hand them to, and a lingering process on a shared runner is a leak.
    daemon: null,
    stopDaemon: false,
    prune: false,
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
    paths: [],
    help: false,
  }

  const percent = (raw, name) => {
    const value = Number.parseInt(raw, 10)

    if (!Number.isInteger(value) || value < 5 || value > 100) {
      throw new Error(`${name} must be an integer between 5 and 100`)
    }

    return value
  }

  const cacheStrategy = (raw) => {
    if (raw !== "metadata" && raw !== "content") {
      throw new Error("--cache-strategy must be metadata or content")
    }

    return raw
  }

  /**
   * Memory can be given as a share ("75", "75%") or as an absolute size
   * ("8G", "8192M"). A bare number meaning "percent" is easy to read as
   * gigabytes, so the absolute form exists and the resolved budget is always
   * echoed back in the header.
   */
  const memoryShare = (raw, name) => {
    const match = (/^(\d+(?:\.\d+)?)\s*(%|g|gb|m|mb)?$/i).exec(String(raw ?? "").trim())

    if (!match) {
      throw new Error(`${name}: expected a percentage (75, 75%) or a size (8G, 8192M)`)
    }

    const amount = Number.parseFloat(match[1])
    const unit = (match[2] || "%").toLowerCase()

    if (unit === "%") {
      return percent(match[1], name)
    }

    const bytes = unit.startsWith("g") ? amount * 1024 ** 3 : amount * 1024 ** 2
    const share = Math.round((bytes / MEMORY_LIMIT) * 100)

    if (share < 5 || share > 100) {
      throw new Error(`${name}: ${raw} is ${share}% of this machine's ${(MEMORY_LIMIT / 1024 ** 3).toFixed(1)}G — allowed range is 5-100%`)
    }

    return share
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]

    if (arg === "-h" || arg === "--help") {
      options.help = true
    } else if (arg === "-t" || arg === "--threads") {
      options.threads = Number.parseInt(argv[++index], 10)
    } else if (arg.startsWith("--threads=")) {
      options.threads = Number.parseInt(arg.slice("--threads=".length), 10)
    } else if (arg === "--max-cpu") {
      options.maxCpu = percent(argv[++index], "--max-cpu")
    } else if (arg.startsWith("--max-cpu=")) {
      options.maxCpu = percent(arg.slice("--max-cpu=".length), "--max-cpu")
    } else if (arg === "--max-memory") {
      options.maxMemory = memoryShare(argv[++index], "--max-memory")
    } else if (arg.startsWith("--max-memory=")) {
      options.maxMemory = memoryShare(arg.slice("--max-memory=".length), "--max-memory")
    } else if (arg === "--no-safeguard") {
      options.safeguard = false
    } else if (arg === "--headless") {
      options.headless = true
    } else if (arg === "--daemon") {
      options.daemon = true
    } else if (arg === "--no-daemon") {
      options.daemon = false
    } else if (arg === "--stop-daemon") {
      options.stopDaemon = true
    } else if (arg === "--prune") {
      options.stopDaemon = true
      options.prune = true
    } else if (arg === "--changed") {
      options.changed = true
    } else if (arg === "--since") {
      options.since = argv[++index]
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
      options.cacheStrategy = cacheStrategy(argv[++index])
    } else if (arg.startsWith("--cache-strategy=")) {
      options.cacheStrategy = cacheStrategy(arg.slice("--cache-strategy=".length))
    } else if (arg === "--max-warnings") {
      options.maxWarnings = Number.parseInt(argv[++index], 10)
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

  if (options.daemon === null) {
    options.daemon = !options.headless && process.env.CI === undefined
  }

  if (options.since !== null && !options.since) {
    throw new Error("--since needs a ref, e.g. --since master")
  }

  return options
}

function printHelp() {
  const c = createPalette(process.stdout.isTTY === true)
  const cores = effectiveCores()

  process.stdout.write(`
  ${c.bold("concurrent-eslint")} ${c.gray("— multi-process ESLint")}

  ${c.bold("Usage")}
    node concurrent-eslint.js [paths...] [options]

  ${c.bold("Options")}
    -t, --threads <n>      worker ceiling ${c.gray(`(default ${cores * 2} = cores × 2)`)}
        --max-cpu <%>      stay under N% CPU ${c.gray(`(default ${DEFAULT_MAX_CPU})`)}
        --max-memory <n>   memory budget: a percentage (75, 75%) or an
                           absolute size (8G, 8192M) ${c.gray(`(default ${DEFAULT_MAX_MEMORY}%)`)}
        --no-safeguard     disable the safeguard ${c.gray("(can take the machine down)")}
        --fix              apply auto-fixable fixes
        --quiet            report errors only, no warnings
        --cache            reuse results for unchanged files ${c.gray(`(kept in ${CACHE_DIR}/)`)}
        --cache-strategy   what marks a file as changed: content ${c.gray("(default)")}
                           or metadata ${c.gray("(mtime + size; a checkout invalidates it)")}
        --max-warnings <n> exit 1 when warnings exceed n
        --changed          only files git reports as changed vs HEAD
        --since <ref>      only files changed since <ref> ${c.gray("(e.g. master)")}
        --headless         no live UI, full-length messages ${c.gray("(for CI)")}
        --no-daemon        one-shot: no workers left behind ${c.gray("(default with --headless or CI)")}
        --daemon           keep them even so
        --stop-daemon      shut the warm workers down
        --prune            shut them down and drop the cache: a truly cold run
        --no-color         disable color
    -h, --help             this help

  ${c.bold("Safeguard")}
    A lint worker costs about ${WORKER_CPU_COST} cores, not one — V8 does GC and
    compilation on background threads — so the pool is sized as
    cores × --max-cpu% ÷ ${WORKER_CPU_COST}, capped by --threads. Right now
    ${c.gray(`${cores} cores → ${Math.max(1, Math.round(cores * DEFAULT_MAX_CPU / 100 / WORKER_CPU_COST))} workers running, ${Math.max(1, Math.floor(cores * DEFAULT_MAX_CPU / 100))} slots.`)}
    From there CPU and memory are sampled every ${SAMPLE_INTERVAL}ms and the pool only
    ever shrinks: surplus workers are parked under sustained load and killed
    under memory pressure, and the rest pick up their files. Each worker also
    gets its own heap cap.
    A worker slot the budget never reached shows as "spare" — its files are
    picked up by the others, nothing is skipped. In the live view ${c.cyan("↙")} counts
    files a worker took off someone else, ${c.gray("↗")} files it handed away, and with
    ${c.gray("--fix")} the ${c.magenta("✎")} counter shows how many lines it rewrote.
    ${c.gray("CE_DEBUG=1 traces every safeguard decision on stderr.")}

  ${c.bold("Daemon")}
    The workers stay alive after the run, and the next run adopts them
    instead of starting fresh ones.
    That skips the config load and, more importantly, keeps the plugins'
    in-process caches warm: import-x's export maps, which are most of what
    the linter does here. Workers retire after ${DAEMON_IDLE_MS / 60000} idle minutes, and are
    replaced on their own when the config, this script, Node or the
    dependencies change. That warmth is memory: together the sleeping
    workers may hold up to ${Math.round(DAEMON_IDLE_SHARE * 100)}% of the ${c.gray("--max-memory")} budget, and one
    that outgrows its share exits instead. ${c.gray("--stop-daemon")} ends them now.
    Under ${c.gray("--headless")} or a CI variable nothing is left behind unless ${c.gray("--daemon")}
    says so; ${c.gray("--no-daemon")} makes any run one-shot.

  ${c.bold("Cache")}
    With ${c.gray("--cache")} every worker writes its own ESLint cache file and after
    the run they are folded into one shared ${c.gray(`${CACHE_DIR}/${CACHE_FILE}`)}, so a
    file stays a hit whichever worker picks it up next time. Files are
    matched by content hash, so switching branches only re-lints what
    actually differs. The summary shows the hit count. ${c.gray("--prune")} drops it.

  ${c.bold("Changed files only")}
    ${c.gray("--changed")} takes the working tree against HEAD plus untracked files;
    ${c.gray("--since master")} adds everything that diverged from the merge base, which
    is the set a review would look at. Deleted files are dropped, ignore
    rules still apply, and the whole tree walk is skipped — on a normal
    branch this turns a minute into a couple of seconds.

  ${c.bold("CI")}
    The live view is skipped automatically when stdout is not a TTY;
    ${c.gray("--headless")} forces that off even on a TTY and stops truncating rule
    messages to the terminal width. Exit code is 1 on any error, on an
    unchecked file, or past ${c.gray("--max-warnings")}.

  ${c.bold("Examples")}
    ${c.gray("node concurrent-eslint.js")}
    ${c.gray("node concurrent-eslint.js app/components --fix")}
    ${c.gray("node concurrent-eslint.js --max-cpu 50 --max-memory 60")}
    ${c.gray("node concurrent-eslint.js --changed --fix")}
    ${c.gray("node concurrent-eslint.js --since master --headless --max-warnings 0")}

`)
}

/* ------------------------------------------------------------------ */
/* File discovery driven by eslint.config.*                            */
/* ------------------------------------------------------------------ */

const CONFIG_NAMES = [
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
  "eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
]

async function findConfigFile(cwd) {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(cwd, name)

    try {
      await fsp.access(candidate)

      return candidate
    } catch {
      // keep looking
    }
  }

  return null
}

function git(args, cwd) {
  return childProcess.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Files git considers changed. Without a base ref that means the working
 * tree against HEAD plus anything untracked; with one, everything that
 * diverged from the merge base as well — the set a review would look at.
 * Deletions are filtered out: there is nothing left to lint.
 */
function collectChangedFiles({ cwd, base }) {
  let root

  try {
    root = git(["rev-parse", "--show-toplevel"], cwd)[0]
  } catch {
    throw new Error("--changed needs a git repository, and this is not one")
  }

  const relative = new Set()
  const add = (paths) => {
    for (const entry of paths) {
      relative.add(entry)
    }
  }

  try {
    add(git(["diff", "--name-only", "--diff-filter=d", "HEAD"], cwd))
  } catch {
    // A repository with no commits yet has no HEAD to diff against.
  }

  add(git(["ls-files", "--others", "--exclude-standard"], cwd))

  if (base) {
    let range = base

    try {
      range = git(["merge-base", base, "HEAD"], cwd)[0] || base
    } catch {
      throw new Error(`--since: cannot resolve "${base}" against HEAD`)
    }

    add(git(["diff", "--name-only", "--diff-filter=d", range], cwd))
  }

  // git prints paths from the repository root, which is not necessarily cwd.
  return [...relative]
    .map((entry) => path.resolve(root, entry))
    .filter((file) => file.startsWith(`${cwd}${path.sep}`) && fs.existsSync(file))
}

/**
 * Walk the tree for candidates. Only the hard skips apply here: the
 * config's own ignore rules are left to the workers, which have the config
 * loaded anyway and drop an ignored file for free. Asking ESLint from the
 * parent means loading every plugin — seconds — to spare the workers a
 * handful of files.
 */
async function collectFiles({ cwd, extensions, onTick }) {
  const extensionSet = new Set(extensions.map((ext) => `.${ext}`))
  const files = []

  async function walk(dir) {
    let entries

    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    const directories = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!HARD_SKIP_DIRS.has(entry.name)) {
          directories.push(path.join(dir, entry.name))
        }

        continue
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue
      }

      if (!extensionSet.has(path.extname(entry.name))) {
        continue
      }

      files.push(path.join(dir, entry.name))
      onTick?.(files.length)
    }

    for (const directory of directories) {
      await walk(directory)
    }
  }

  await walk(cwd)

  return files.sort()
}

/* ------------------------------------------------------------------ */
/* Spreading files across workers                                      */
/* ------------------------------------------------------------------ */

/**
 * Contiguous slices of the sorted list, so a worker gets whole directories.
 * Files next to each other import the same modules, and import-x builds an
 * export map for every module a worker's files import — once per worker.
 * Dealing round-robin spreads heavy .vue files evenly but makes every worker
 * parse nearly every module; slicing measured 9% faster end to end, and
 * work stealing evens out the load either way.
 */
function shard(files, threads) {
  const edge = (index) => Math.floor((index * files.length) / threads)

  return Array.from({ length: threads }, (_unused, index) => files.slice(edge(index), edge(index + 1)))
}

/* ------------------------------------------------------------------ */
/* Shared cache                                                        */
/* ------------------------------------------------------------------ */

/**
 * flat-cache is what ESLint writes its cache with. It is ESLint's own
 * dependency, so it is resolved from ESLint's tree rather than assumed to
 * be hoisted next to ours.
 */
function loadFlatCache() {
  const from = (request, base) => require.resolve(request, { paths: [path.dirname(base)] })
  const fileEntryCache = from("file-entry-cache", require.resolve("eslint"))

  return require(from("flat-cache", fileEntryCache))
}

function workerCacheFile(cwd, index) {
  return path.join(cwd, CACHE_DIR, `worker-${index}.json`)
}

/**
 * Fold the workers' cache files into the shared one.
 *
 * A flat-cache file cannot be shared between processes, so every worker
 * starts from a copy of the shared file and writes its own. After the run —
 * and before the next one, to pick up what an interrupted run left behind —
 * the copies are merged back: an entry that differs from what the worker
 * started with is one it linted, and wins. Entries for files that no longer
 * exist are dropped. Returns how many entries were refreshed.
 */
function mergeCache(cwd) {
  const dir = path.join(cwd, CACHE_DIR)
  let partials

  try {
    partials = fs.readdirSync(dir).filter((name) => name.endsWith(".json") && name !== CACHE_FILE)
  } catch {
    return 0
  }

  if (partials.length === 0) {
    return 0
  }

  const flatCache = loadFlatCache()
  const merged = flatCache.load(CACHE_FILE, dir)
  const before = new Map(Object.entries(merged.all()).map(([file, entry]) => [file, JSON.stringify(entry)]))
  let refreshed = 0

  for (const name of partials) {
    const partial = flatCache.load(name, dir)

    for (const [file, entry] of Object.entries(partial.all())) {
      if (before.get(file) !== JSON.stringify(entry)) {
        merged.setKey(file, entry)
        refreshed += 1
      }
    }
  }

  for (const file of merged.keys()) {
    if (!fs.existsSync(file)) {
      merged.removeKey(file)
    }
  }

  merged.save(true)

  for (const name of partials) {
    fs.rmSync(path.join(dir, name), { force: true })
  }

  return refreshed
}

/* ------------------------------------------------------------------ */
/* Warm workers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Workers talk to the parent over a unix socket rather than the fork IPC
 * channel, so they can outlive the run and be adopted by the next one. The
 * sockets live outside the project, keyed by its path.
 */
function socketDir(cwd) {
  const id = crypto.createHash("md5").update(cwd).digest("hex").slice(0, 8)

  return path.join(os.tmpdir(), `concurrent-eslint-${id}`)
}

/**
 * What a warm worker was built from. A worker whose epoch differs from the
 * client's is stale — another script, config, Node or dependency tree — and
 * is shut down instead of adopted. ESLint caches the config module for the
 * life of the process, so even a config edit has to restart the workers.
 */
function computeEpoch(cwd, configFile) {
  const mtime = (file) => {
    try {
      return String(fs.statSync(file).mtimeMs)
    } catch {
      return "-"
    }
  }

  const parts = [
    process.version,
    mtime(__filename),
    mtime(configFile),
    mtime(path.join(cwd, "package.json")),
    mtime(path.join(cwd, "yarn.lock")),
    mtime(path.join(cwd, "package-lock.json")),
    mtime(path.join(cwd, "pnpm-lock.yaml")),
    mtime(path.join(cwd, "node_modules", ".yarn-integrity")),
    mtime(path.join(cwd, "node_modules", ".package-lock.json")),
    mtime(path.join(cwd, "node_modules", ".modules.yaml")),
  ]

  return crypto.createHash("md5").update(parts.join("|")).digest("hex").slice(0, 12)
}

/** Newline-delimited JSON over a socket. The handler can be swapped later. */
function frame(socket) {
  let handler = () => {}
  let buffer = ""

  socket.setEncoding("utf8")
  socket.on("data", (chunk) => {
    buffer += chunk

    let index = buffer.indexOf("\n")

    while (index !== -1) {
      const line = buffer.slice(0, index)

      buffer = buffer.slice(index + 1)

      if (line) {
        handler(JSON.parse(line))
      }

      index = buffer.indexOf("\n")
    }
  })

  return {
    send(message) {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(message)}\n`)
      }
    },
    on(next) {
      handler = next
    },
  }
}

/**
 * Connect to a worker and wait for its greeting. Retries while the socket
 * is not there yet or nobody answers — a worker that is still starting, or
 * a leftover file — until the deadline.
 */
function connect(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs

    const attempt = () => {
      const socket = net.connect(socketPath)

      socket.once("error", (error) => {
        socket.destroy()

        if (Date.now() < deadline && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
          setTimeout(attempt, 50)
        } else {
          reject(error)
        }
      })

      socket.once("connect", () => {
        const io = frame(socket)
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error("worker did not answer"))
        }, Math.max(1000, deadline - Date.now()))

        io.on((hello) => {
          clearTimeout(timer)
          resolve({ socket, io, hello })
        })
      })
    }

    attempt()
  })
}

/** Ask every warm worker of this project to exit. Returns how many did. */
async function stopWarmWorkers(sockets) {
  let names

  try {
    names = fs.readdirSync(sockets).filter((name) => name.endsWith(".sock"))
  } catch {
    return 0
  }

  let stopped = 0

  await Promise.all(names.map(async (name) => {
    const socketPath = path.join(sockets, name)

    try {
      const { socket, io, hello } = await connect(socketPath, PROBE_TIMEOUT_MS)

      if (hello.type === "hello") {
        io.send({ type: "shutdown" })
        stopped += 1
      }

      socket.end()
    } catch {
      // Nobody there — just the file.
    }

    fs.rmSync(socketPath, { force: true })
    fs.rmSync(socketPath.replace(/\.sock$/, ".stderr"), { force: true })
  }))

  return stopped
}

/* ------------------------------------------------------------------ */
/* Live output                                                         */
/* ------------------------------------------------------------------ */

class Reporter {
  constructor({ palette, workers, total, governor, stream, headless }) {
    this.ourRss = 0
    this.c = palette
    this.workers = workers
    this.total = total
    this.governor = governor
    this.stream = stream
    this.live = stream.isTTY === true && headless !== true
    this.renderedLines = 0
    this.frame = 0
    this.startedAt = Date.now()
    this.timer = null
  }

  width() {
    return this.stream.columns && this.stream.columns > 20 ? this.stream.columns : 120
  }

  start() {
    if (!this.live) {
      return
    }

    this.stream.write(`${ESC}[?25l`)
    this.timer = setInterval(() => {
      this.frame += 1
      this.render()
    }, 80)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    if (this.live) {
      this.render()
      this.stream.write(`${ESC}[?25h`)
    }
  }

  clear() {
    if (!this.live || this.renderedLines === 0) {
      return
    }

    this.stream.write(`${ESC}[${this.renderedLines}A${ESC}[0J`)
    this.renderedLines = 0
  }

  /** Print above the live block: erase it, write, then redraw. */
  print(text) {
    this.clear()
    this.stream.write(`${text}\n`)
    this.render()
  }

  elapsed() {
    return (Date.now() - this.startedAt) / 1000
  }

  gauge(label, value, limit, note) {
    const c = this.c
    const paint = value > limit ? c.red : value > limit - 0.15 ? c.yellow : c.green
    const suffix = note ? ` ${c.dim(note)}` : ""

    return `${c.dim(label)} ${paint(brailleBar(value, 1, 8))} ${paint(padStart(`${Math.round(value * 100)}%`, 4))}${suffix}`
  }

  workerLine(worker, index) {
    const c = this.c
    // One error anywhere turns the whole block red; green otherwise.
    const paint = worker.errors > 0 ? c.red : c.green
    const marks = {
      done: DONE_MARK,
      parked: PARKED_MARK,
      cold: COLD_MARK,
    }
    const spinner = marks[worker.state] ?? SPINNER[(this.frame + index * 3) % SPINNER.length]
    const id = String(index + 1).padStart(2, "0")
    const bar = brailleBar(worker.done, Math.max(worker.assigned, 1))
    const counter = `${padStart(worker.done, String(this.total).length)}/${worker.assigned}`
    const stats = []

    if (worker.errors > 0) {
      stats.push(c.red(`✖ ${worker.errors}`))
    }

    if (worker.warnings > 0) {
      stats.push(c.yellow(`⚠ ${worker.warnings}`))
    }

    if (worker.fixedLines > 0) {
      stats.push(c.magenta(`✎ ${worker.fixedLines}`))
    }

    // Work stealing: ↙ took files off another worker, ↗ handed its own away.
    // Without this the denominators look like they drift for no reason.
    if (worker.stolen > 0) {
      stats.push(c.cyan(`↙ ${worker.stolen}`))
    }

    if (worker.reassigned > 0) {
      stats.push(c.dim(`↗ ${worker.reassigned}`))
    }

    const labels = {
      done: c.dim(worker.errors > 0 ? "done, with errors" : "done"),
      parked: c.yellow("parked — safeguard"),
      waiting: c.dim("warm, waiting for files"),
      // A slot the safeguard never had budget for is spare capacity, not a
      // casualty: its files are stolen by the workers that did run.
      cold: c.dim(worker.reassigned > 0
        ? `${worker.started ? "stopped" : "spare"} — ${plural(worker.reassigned, "file")} reassigned`
        : (worker.started ? "stopped — safeguard" : "spare — no budget")),
      starting: c.dim("starting…"),
    }
    const head = `${paint(spinner)} ${c.dim(id)} ${paint(bar)} ${paint(padEnd(counter, 10))}`
    const tail = stats.length > 0 ? `${stats.join(" ")} ` : ""
    const label = labels[worker.state] ?? c.dim(worker.current || "…")
    const used = visibleLength(head) + visibleLength(tail) + 2

    return ` ${head}${tail}${truncate(label, this.width() - used)}`
  }

  render() {
    if (!this.live) {
      return
    }

    this.clear()

    const c = this.c
    const governor = this.governor
    const done = this.workers.reduce((sum, worker) => sum + worker.done, 0)
    const errors = this.workers.reduce((sum, worker) => sum + worker.errors, 0)
    const warnings = this.workers.reduce((sum, worker) => sum + worker.warnings, 0)
    const active = this.workers.filter((worker) => worker.state === "busy" || worker.state === "starting").length
    const percent = this.total > 0 ? Math.floor((done / this.total) * 100) : 100
    const paint = errors > 0 ? c.red : c.green
    const lines = [""]

    lines.push([
      ` ${paint(brailleBar(done, this.total, 24))}`,
      c.bold(padStart(`${percent}%`, 4)),
      c.dim(`${done}/${this.total}`),
      ` ${c.red(`✖ ${errors}`)}`,
      c.yellow(`⚠ ${warnings}`),
      c.dim(`${this.elapsed().toFixed(1)}s`),
    ].join("  "))

    lines.push([
      ` ${this.gauge("CPU", governor.cpu, governor.cpuLimit)}`,
      this.gauge("RAM", governor.memory, governor.memoryLimit, this.ourRss > 0 ? `(${(this.ourRss / 1073741824).toFixed(1)}G ours)` : ""),
      c.dim(`workers ${active}/${governor.limit}`),
      governor.holding
        ? c.red(`held — waiting for RAM to drop below ${Math.round((governor.memoryLimit - MEMORY_UP_MARGIN) * 100)}%`)
        : governor.throttled ? c.yellow("safeguard holding back") : c.dim(""),
    ].join("  ").trimEnd())

    lines.push("")

    for (const [index, worker] of this.workers.entries()) {
      lines.push(this.workerLine(worker, index))
    }

    lines.push("")

    const width = this.width()
    const body = lines
      .map((line) => (c.enabled ? `${truncate(line, width)}${RESET}` : truncate(line, width)))
      .join("\n")

    this.stream.write(`${body}\n`)
    this.renderedLines = lines.length
  }
}

/* ------------------------------------------------------------------ */
/* Problem formatting                                                  */
/* ------------------------------------------------------------------ */

function formatResult(result, cwd, palette, quiet, headless) {
  const c = palette
  const messages = quiet
    ? result.messages.filter((message) => message.severity === 2)
    : result.messages

  if (messages.length === 0) {
    return null
  }

  const relative = path.relative(cwd, result.filePath) || result.filePath
  const rows = messages.map((message) => ({
    position: `${message.line || 0}:${message.column || 0}`,
    severity: message.severity === 2 ? c.red("error  ") : c.yellow("warning"),
    text: (message.message || "").replace(/\s+/g, " ").trim(),
    rule: message.ruleId || "",
  }))

  const positionWidth = Math.max(...rows.map((row) => row.position.length))
  const longest = Math.max(...rows.map((row) => row.text.length))
  // A CI log has no width to fit: never cut a rule message there.
  const textWidth = headless
    ? longest
    : Math.min(longest, Math.max(40, (process.stdout.columns || 120) - positionWidth - 34))

  const body = rows
    .map((row) => [
      `  ${c.dim(padEnd(row.position, positionWidth))}`,
      row.severity,
      padEnd(truncate(row.text, textWidth), textWidth),
      c.dim(row.rule),
    ].join("  "))
    .join("\n")

  return `${c.underline(c.bold(relative))}\n${body}`
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

function runWorker() {
  const { ESLint } = require("eslint")

  const token = process.env.CE_TOKEN
  const socketPath = process.env.CE_SOCKET
  const epoch = process.env.CE_EPOCH
  const heapMb = Number(process.env.CE_HEAP)
  const persistent = process.env.CE_PERSIST === "1"
  const idleMs = persistent ? DAEMON_IDLE_MS : ORPHAN_IDLE_MS

  let client = null
  let idleTimer = null
  let trimTimer = null
  let server = null
  let idleRssBudget = 0
  // The slot this worker last served, so the next run can hand it the same
  // slice of the tree: its caches then cover the modules that slice
  // imports, instead of growing towards the whole project.
  let lastShard = -1

  const leave = (code) => {
    server?.close()
    fs.rmSync(socketPath, { force: true })
    fs.rmSync(socketPath.replace(/\.sock$/, ".stderr"), { force: true })
    process.exit(code)
  }

  const rearm = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => leave(0), idleMs)
  }

  /** How much of the file --fix actually rewrote. */
  function changedLines(before, after) {
    const a = before.split("\n")
    const b = after.split("\n")
    let changed = 0

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        changed += 1
      }
    }

    return changed
  }

  function serialize(result, fixedLines) {
    return {
      filePath: result.filePath,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      fixableErrorCount: result.fixableErrorCount,
      fixableWarningCount: result.fixableWarningCount,
      fixedLines,
      messages: result.messages.map((message) => ({
        line: message.line,
        column: message.column,
        severity: message.severity,
        message: message.message,
        ruleId: message.ruleId,
      })),
    }
  }

  /**
   * One client at a time. Every job gets a fresh ESLint instance — that is
   * cheap once the plugins are loaded — while the module-level caches the
   * plugins keep survive from job to job.
   */
  function serve(socket) {
    const io = frame(socket)

    if (client) {
      io.send({ type: "busy" })
      socket.end()

      return
    }

    client = socket
    clearTimeout(idleTimer)
    clearTimeout(trimTimer)

    let eslint = null
    let options = null

    const { send } = io

    async function lintBatch(files) {
      send({ type: "start", file: files[0], batch: files.length })

      let results = []
      let failure = null

      try {
        // One call for the whole batch. Linting files one at a time costs
        // roughly 1.8x the wall clock and 2x the CPU of a batched call —
        // ESLint redoes a lot of per-invocation work otherwise.
        results = await eslint.lintFiles(files)
      } catch (error) {
        failure = error?.message || String(error)
      }

      if (failure) {
        for (const file of files) {
          send({ type: "result", file, failure, result: null })
        }

        send({ type: "idle" })

        return
      }

      const reported = new Set()

      for (const result of results) {
        let fixedLines = 0

        if (options.fix && result.output !== undefined) {
          // outputFixes writes the file, so capture the original first.
          const before = await fsp.readFile(result.filePath, "utf8").catch(() => null)

          await ESLint.outputFixes([result])
          fixedLines = before === null ? 1 : changedLines(before, result.output)
        }

        reported.add(path.resolve(result.filePath))
        send({ type: "result", file: result.filePath, failure: null, result: serialize(result, fixedLines) })
      }

      // ESLint can return fewer results than inputs; the parent counts one
      // result per dispatched file, so account for the rest or the run hangs.
      for (const file of files) {
        if (!reported.has(path.resolve(file))) {
          // No result means ESLint ignored it: counted, but not a checked file.
          send({ type: "result", file, failure: null, result: null, ignored: true })
        }
      }

      send({ type: "idle" })
    }

    async function handle(message) {
      switch (message.type) {
        case "job":
          options = message.options
          idleRssBudget = options.idleRssBudget ?? 0
          lastShard = options.shard ?? -1
          eslint = new ESLint({
            cwd: options.cwd,
            fix: options.fix,
            cache: options.cache,
            cacheLocation: options.cacheLocation,
            cacheStrategy: options.cacheStrategy,
            errorOnUnmatchedPattern: false,
            warnIgnored: false,
          })
          send({ type: "ready" })
          break
        case "batch":
          await lintBatch(message.files)
          break
        case "release":
          socket.end()
          break
        case "shutdown":
          leave(0)
          break
        default:
          break
      }
    }

    io.on((message) => {
      handle(message).catch((error) => {
        send({ type: "fatal", error: error?.message || String(error) })
        leave(1)
      })
    })

    socket.on("error", () => {
      // The close that follows is what matters.
    })

    // Losing the client is a release either way: a warm worker goes back to
    // sleep, a one-shot one has nothing left to do.
    socket.on("close", () => {
      client = null
      eslint = null

      if (!persistent) {
        leave(0)

        return
      }

      rearm()

      // The job's ASTs and results are garbage now; without a collection
      // they sit in the idle worker's heap until the next job. Only the
      // plugins' module-level caches are meant to survive. Once V8 has had
      // its idle time to return pages, a worker still past the share of
      // memory a sleeping one is allowed is not worth keeping.
      globalThis.gc?.()
      clearTimeout(trimTimer)
      trimTimer = setTimeout(() => {
        globalThis.gc?.()

        if (!client && idleRssBudget > 0 && processRss(process.pid) > idleRssBudget) {
          leave(0)
        }
      }, TRIM_DELAY_MS)
    })

    send({ type: "hello", pid: process.pid, token, epoch, heapMb, shard: lastShard })
  }

  server = net.createServer(serve)
  fs.rmSync(socketPath, { force: true })
  server.listen(socketPath)
  rearm()

  process.on("SIGTERM", () => leave(0))
}

/* ------------------------------------------------------------------ */
/* Main process                                                        */
/* ------------------------------------------------------------------ */

async function main() {
  let options

  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }

  if (options.help) {
    printHelp()

    return
  }

  const cwd = process.cwd()
  const c = createPalette(options.color)
  const configFile = await findConfigFile(cwd)

  if (!configFile) {
    process.stderr.write(`${c.red("No eslint.config.* found")} in ${cwd}\n`)
    process.exit(2)
  }

  /* --- file discovery ---------------------------------------------- */

  const discoveryStart = Date.now()
  let discovered = 0

  const spinnerTimer = process.stdout.isTTY && !options.headless
    ? setInterval(() => {
      const frame = SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]

      process.stdout.write(`\r${ESC}[2K ${c.cyan(frame)} ${c.dim(`globbing — ${discovered}…`)}`)
    }, 80)
    : null

  const extensionSet = new Set(DEFAULT_EXTENSIONS.map((ext) => `.${ext}`))

  // The parent never loads the config: the walk is a plain readdir with the
  // hard skips, and in --changed mode git already knows the answer. Either
  // way ESLint's ignore rules get the final say inside the workers.
  const findFiles = async () => {
    if (!options.changed) {
      return collectFiles({
        cwd,
        extensions: DEFAULT_EXTENSIONS,
        onTick: (kept) => {
          discovered = kept
        },
      })
    }

    const candidates = collectChangedFiles({ cwd, base: options.since })
      .filter((file) => extensionSet.has(path.extname(file)))

    discovered = candidates.length

    return candidates.sort()
  }

  const discovery = findFiles().finally(() => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer)
      process.stdout.write(`\r${ESC}[2K`)
    }
  })

  /* --- warm workers ------------------------------------------------- */

  const sockets = socketDir(cwd)

  if (options.stopDaemon) {
    const count = await stopWarmWorkers(sockets)
    const notes = [count > 0 ? c.green(`${DONE_MARK} stopped ${plural(count, "warm worker")}`) : c.dim("no warm workers were running")]

    if (options.prune) {
      const cacheDir = path.join(cwd, CACHE_DIR)
      const had = fs.existsSync(path.join(cacheDir, CACHE_FILE))

      fs.rmSync(cacheDir, { recursive: true, force: true })
      notes.push(had ? c.green(`${DONE_MARK} cache dropped`) : c.dim("no cache to drop"))
    }

    process.stdout.write(`\n ${notes.join("  ")}\n\n`)

    return
  }

  fs.mkdirSync(sockets, { recursive: true })

  /* --- shared cache ------------------------------------------------- */

  // Whatever an interrupted run left behind is folded in first, so no
  // worker starts from a stale copy.
  if (options.cache) {
    fs.mkdirSync(path.join(cwd, CACHE_DIR), { recursive: true })
    mergeCache(cwd)
  }

  /* --- safeguard: how many workers we may run at all ---------------- */

  const cores = effectiveCores()
  const cpuLimit = options.maxCpu / 100
  const memoryLimit = options.maxMemory / 100
  const cpuCeiling = Math.max(1, Math.floor(cores * cpuLimit))
  // What the CPU budget is really expected to support, once a worker is
  // priced at what it actually costs.
  const expectedWorkers = Math.max(1, Math.round(cores * cpuLimit / WORKER_CPU_COST))
  const requested = options.threads
  const ceiling = options.safeguard ? Math.min(requested, cpuCeiling) : requested
  const threads = Math.max(1, ceiling)

  const budgetBytes = MEMORY_LIMIT * memoryLimit
  const availableBytes = Math.max(0, budgetBytes - MEMORY_LIMIT * memoryUsage())
  // How many workers the machine can hold, judged against the budget rather
  // than against whatever happens to be free this second. A browser and an
  // IDE holding half the RAM are not ours to plan around; if they really are
  // in the way, the runtime safeguard holds the pool until they let go.
  const affordableWorkers = Math.max(1, Math.floor(budgetBytes / (WORKER_RSS_ESTIMATE_MB * 1024 * 1024)))
  const poolSize = options.safeguard
    ? Math.max(1, Math.min(expectedWorkers, affordableWorkers))
    : threads
  const memoryBound = options.safeguard && affordableWorkers < expectedWorkers
  const workerHeapMb = Math.max(
    MIN_VIABLE_HEAP_MB,
    Math.min(MAX_WORKER_HEAP_MB, Math.floor(budgetBytes / poolSize / (1024 * 1024))),
  )
  // Starting with the machine already past the budget is allowed — the pool
  // simply spends its first samples waiting instead of working.
  const overcommitted = options.safeguard && availableBytes < MIN_VIABLE_HEAP_MB * 1024 * 1024
  const totalGb = (MEMORY_LIMIT / 1024 ** 3).toFixed(1)
  const budgetGb = (MEMORY_LIMIT * memoryLimit / 1024 ** 3).toFixed(1)
  // Resident size at which a worker is recycled, so the pool stays inside
  // the budget instead of only reacting once the machine is already tight.
  const perWorkerRssBudget = options.safeguard
    ? (MEMORY_LIMIT * memoryLimit * RECYCLE_HEADROOM) / poolSize
    : 0

  const flags = [
    options.fix ? "--fix" : null,
    options.quiet ? "--quiet" : null,
    options.cache ? `--cache (${options.cacheStrategy})` : null,
    options.headless ? "--headless" : null,
    options.daemon ? null : "--no-daemon",
  ]
    .filter(Boolean)
    .join(" ")

  // The first batch of every worker; from there each worker sizes its own.
  let batchSize = 1
  // Files from a batch that killed a worker. They are retried one at a
  // time, so the crash can be pinned on a single file instead of blaming
  // the whole batch.
  const suspects = new Set()

  const workers = Array.from({ length: threads }, (_unused, index) => ({
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
    fixedFiles: 0,
    fixedLines: 0,
    queue: [],
    inFlight: [],
    batchSize: 0,
    batchStartedAt: 0,
    child: null,
  }))

  const governor = new Governor({
    maxWorkers: threads,
    startAt: poolSize,
    cpuLimit,
    memoryLimit,
    enabled: options.safeguard,
    getActive: () => activeCount(),
    isSettling: () => warming || workers.some((worker) => worker.state === "starting" || worker.state === "waiting"),
    getOurShare: () => totals.ourRss / MEMORY_LIMIT,
  })

  let reporter = null


  const totals = {
    errors: 0,
    warnings: 0,
    fixableErrors: 0,
    fixableWarnings: 0,
    filesWithProblems: 0,
    fixedFiles: 0,
    fixedLines: 0,
    parked: 0,
    killed: 0,
    recycled: 0,
    oom: 0,
    rebalanced: 0,
    ignored: 0,
    adopted: 0,
    ourRss: 0,
    heldMs: 0,
    peakRss: 0,
    peakMemory: 0,
    crashes: [],
    failures: [],
  }

  // A file that killed a worker must not wander the pool forever.
  const attempts = new Map()

  let stopped = false
  // While warming, the pool has no files yet: a ready worker waits instead of
  // declaring itself done, and an empty pool is not a finished one.
  let warming = true
  let lastSpawnAt = 0
  // Set once the pool has been filled: from then on spawns are staggered.
  let filled = false
  let lastRecycleAt = 0
  // CE_HEAP_MB forces the per-worker heap. Meant for reproducing memory
  // failures on a machine that would not otherwise hit them.
  let heapMb = Number.parseInt(process.env.CE_HEAP_MB ?? "", 10) || workerHeapMb

  const epoch = computeEpoch(cwd, configFile)
  // Warm workers found at start, connected and greeted, waiting for a job.
  const adoptable = []

  // Runs alongside discovery. A stale worker is told to leave, a busy one
  // (another run is using it) is left alone, a dead one's files are swept.
  const adoption = (async () => {
    let names

    try {
      names = fs.readdirSync(sockets).filter((name) => name.endsWith(".sock"))
    } catch {
      return
    }

    await Promise.all(names.map(async (name) => {
      const socketPath = path.join(sockets, name)

      try {
        const warm = await connect(socketPath, PROBE_TIMEOUT_MS)

        if (warm.hello.type !== "hello") {
          warm.socket.destroy()

          return
        }

        // Stale, or started with a smaller heap than this run wants — a
        // survivor of a run that was probing for memory failures.
        if (warm.hello.epoch !== epoch || warm.hello.heapMb < heapMb) {
          warm.io.send({ type: "shutdown" })
          warm.socket.end()
          fs.rmSync(socketPath.replace(/\.sock$/, ".stderr"), { force: true })

          return
        }

        adoptable.push(warm)
      } catch {
        fs.rmSync(socketPath, { force: true })
        fs.rmSync(socketPath.replace(/\.sock$/, ".stderr"), { force: true })
      }
    }))
  })()

  let poolTarget = poolSize
  let activeSamples = 0
  let activeSum = 0
  let resolveRun = null
  const run = new Promise((resolve) => {
    resolveRun = resolve
  })

  const activeCount = () => workers.filter((worker) => worker.state === "busy" || worker.state === "starting").length
  const pendingWork = () => workers.reduce((sum, worker) => sum + worker.queue.length + worker.inFlight.length, 0)

  /** A worker that is gone leaves no files behind. */
  function forget(link) {
    fs.rmSync(path.join(sockets, `w-${link.token}.sock`), { force: true })
    fs.rmSync(path.join(sockets, `w-${link.token}.stderr`), { force: true })
  }

  /**
   * Let a worker go. A warm one goes back to sleep the moment its socket
   * closes; a one-shot one exits. Sending the release first lets a warm
   * worker finish what is in flight cleanly.
   */
  function retire(worker) {
    const link = worker.child

    if (!link) {
      return
    }

    worker.child = null
    link.send({ type: link.persistent ? "release" : "shutdown" })
    link.socket?.end()

    if (!link.persistent) {
      forget(link)
    }
  }

  /** Get rid of a worker for good, warm or not: it is too fat to keep. */
  function discard(worker) {
    const link = worker.child

    if (!link) {
      return
    }

    worker.child = null
    link.send({ type: "shutdown" })
    link.socket?.end()
    link.kill("SIGTERM")
    forget(link)
  }

  function releaseAdoptable() {
    for (const warm of adoptable.splice(0)) {
      warm.io.send({ type: "release" })
      warm.socket.end()
    }
  }

  function killAll() {
    for (const worker of workers) {
      const link = worker.child

      worker.child = null

      if (!link) {
        continue
      }

      if (link.persistent) {
        link.socket?.destroy()
      } else {
        link.kill("SIGKILL")
        forget(link)
      }
    }

    releaseAdoptable()
  }

  function finish() {
    if (stopped) {
      return
    }

    stopped = true
    governor.stop()

    for (const worker of workers) {
      retire(worker)

      // A slot that never ran stays "spare" in the final frame — calling it
      // "done" would imply it did work it never got.
      worker.state = worker.started ? "done" : "cold"
      worker.current = ""
    }

    releaseAdoptable()
    setTimeout(killAll, 2000).unref?.()
    resolveRun()
  }

  function maybeFinish() {
    if (!stopped && !warming && pendingWork() === 0) {
      finish()
    }
  }

  process.on("SIGINT", () => {
    stopped = true
    governor.stop()
    reporter.stop()
    killAll()
    process.stdout.write(`\n ${c.yellow("Interrupted")}\n\n`)
    process.exit(130)
  })

  /**
   * Take work from the longest foreign queue. From stopped and parked
   * workers we take even the last file — otherwise it would sit there forever.
   */
  function steal(worker) {
    let donor = null

    for (const candidate of workers) {
      if (candidate === worker || candidate.queue.length === 0) {
        continue
      }

      const idle = candidate.state === "cold" || candidate.state === "parked"

      if (!idle && candidate.queue.length < 2) {
        continue
      }

      if (!donor || candidate.queue.length > donor.queue.length) {
        donor = candidate
      }
    }

    if (!donor) {
      return false
    }

    const idle = donor.state === "cold" || donor.state === "parked"
    const take = idle ? donor.queue.length : Math.max(1, Math.floor(donor.queue.length / 2))
    const stolen = donor.queue.splice(donor.queue.length - take, take)

    donor.assigned -= stolen.length
    donor.reassigned += stolen.length
    worker.queue.push(...stolen)
    worker.assigned += stolen.length
    worker.stolen += stolen.length
    totals.rebalanced += stolen.length

    return true
  }

  function dispatch(worker) {
    if (stopped) {
      return
    }

    // A worker torn down for recycling can still deliver messages that were
    // already in the IPC pipe when it was killed. There is nothing to give it;
    // balance() brings it back with its queue intact.
    if (!worker.child) {
      return
    }

    // Recycling happens here, between batches, so nothing is in flight and no
    // file is charged a crash attempt. The queue stays; balance() restarts it.
    if (worker.recycle) {
      discard(worker)
      worker.recycle = false
      worker.recycled += 1
      worker.rss = 0
      worker.state = "cold"
      worker.current = ""
      totals.recycled += 1

      return
    }

    // The safeguard caps how many workers may run at once, and while it is
    // holding for memory nobody gets work at all.
    if (governor.holding || activeCount() > governor.limit) {
      worker.state = "parked"
      worker.current = ""
      totals.parked += 1
      maybeFinish()

      return
    }

    if (worker.queue.length === 0 && !steal(worker)) {
      if (warming) {
        worker.state = "waiting"
        worker.current = ""

        return
      }

      worker.state = "done"
      worker.current = ""
      retire(worker)
      maybeFinish()

      return
    }

    if (worker.batchSize === 0) {
      worker.batchSize = batchSize
    }

    // A suspect goes alone, so a second crash names the file.
    const take = suspects.has(worker.queue[0]) ? 1 : worker.batchSize
    const batch = worker.queue.splice(0, take)

    worker.inFlight = [...batch]
    worker.batchCount = batch.length
    worker.state = "busy"
    worker.batchStartedAt = Date.now()
    worker.child.send({ type: "batch", files: batch })
  }

  /** Size the next batch from how long the last one took. */
  function adaptBatch(worker, count) {
    const elapsed = Math.max(1, Date.now() - worker.batchStartedAt)
    const wanted = Math.floor(BATCH_TARGET_MS / (elapsed / count))

    worker.batchSize = Math.max(1, Math.min(MAX_BATCH, wanted, worker.batchSize * BATCH_GROWTH))
  }

  function handleResult(worker, message) {
    worker.done += 1
    worker.inFlight = worker.inFlight.filter((file) => file !== message.file)
    suspects.delete(message.file)

    if (message.failure) {
      worker.errors += 1
      totals.errors += 1
      totals.failures.push({ file: path.relative(cwd, message.file), error: message.failure })
      reporter.print(`\n${c.underline(c.bold(path.relative(cwd, message.file)))}\n  ${c.red("lint failed")}  ${c.dim(message.failure)}`)

      return
    }

    const result = message.result

    if (!result) {
      if (message.ignored) {
        totals.ignored += 1
      }

      return
    }

    if (result.fixedLines > 0) {
      worker.fixedFiles += 1
      worker.fixedLines += result.fixedLines
      totals.fixedFiles += 1
      totals.fixedLines += result.fixedLines
    }

    worker.errors += result.errorCount
    worker.warnings += result.warningCount
    totals.errors += result.errorCount
    totals.warnings += result.warningCount
    totals.fixableErrors += result.fixableErrorCount
    totals.fixableWarnings += result.fixableWarningCount

    const visible = options.quiet ? result.errorCount : result.errorCount + result.warningCount

    if (visible === 0) {
      return
    }

    totals.filesWithProblems += 1

    const block = formatResult(result, cwd, c, options.quiet, options.headless)

    if (block) {
      reporter.print(`\n${block}`)
    }
  }

  /**
   * Return orphaned files to the pool. A file that has already killed a
   * worker MAX_ATTEMPTS times on its own is not retried — it would take
   * down the whole pool one worker at a time; we mark it unchecked instead.
   * A crash under a batch blames nobody yet: the batch is retried one file
   * at a time until the culprit crashes alone.
   */
  function requeue(worker) {
    const orphans = []
    const alone = worker.inFlight.length === 1

    // Only the in-flight files actually went through the crash.
    for (const file of worker.inFlight) {
      suspects.add(file)

      const attempt = alone ? (attempts.get(file) ?? 0) + 1 : attempts.get(file) ?? 0

      attempts.set(file, attempt)

      if (attempt >= MAX_ATTEMPTS) {
        totals.failures.push({
          file: path.relative(cwd, file),
          error: `crashed the worker ${attempt} times in a row — file left unchecked (worker heap: ${heapMb} MB)`,
        })
        // Count it as processed, otherwise progress never reaches the end.
        worker.done += 1
        worker.errors += 1
        continue
      }

      orphans.push(file)
    }

    orphans.push(...worker.queue)
    worker.inFlight = []
    worker.queue = []

    if (orphans.length === 0) {
      return
    }

    worker.assigned -= orphans.length
    worker.reassigned += orphans.length

    const targets = workers.filter((candidate) => candidate !== worker && candidate.state !== "done")

    if (targets.length === 0) {
      // Nobody to hand them to — keep them; balance() will respawn this worker.
      worker.queue = orphans
      worker.assigned += orphans.length
      worker.reassigned -= orphans.length

      return
    }

    totals.rebalanced += orphans.length

    orphans.forEach((file, offset) => {
      const target = targets[offset % targets.length]

      target.queue.push(file)
      target.assigned += 1
      target.stolen += 1
    })
  }

  function onMessage(worker, message) {
    switch (message.type) {
      case "ready":
        dispatch(worker)
        break
      case "start":
        worker.current = path.relative(cwd, message.file)
          + (message.batch > 1 ? ` ${c.dim(`+${message.batch - 1}`)}` : "")
        break
      case "result":
        handleResult(worker, message)
        break
      case "idle":
        adaptBatch(worker, worker.batchCount)
        dispatch(worker)
        break
      case "fatal":
        totals.failures.push({ file: `worker #${worker.index + 1}`, error: message.error })
        break
      default:
        break
    }
  }

  function stderrTail(link) {
    try {
      return fs.readFileSync(path.join(sockets, `w-${link.token}.stderr`), "utf8").slice(-4000)
    } catch {
      return ""
    }
  }

  /** The socket closed under us: the worker died, or never came up. */
  function onLost(worker, link) {
    // Not ours any more — we let it go on purpose.
    if (worker.child !== link) {
      return
    }

    worker.child = null
    worker.current = ""

    const stderr = stderrTail(link)

    forget(link)

    if (stopped) {
      return
    }

    // Died on its own — hand the files back, worker goes cold.
    worker.state = "cold"

    // V8 aborts the process when it cannot grow the heap. Respawning into
    // the same limit just repeats the crash, so the limit has to move.
    const outOfMemory = stderr.includes("heap out of memory")

    if (outOfMemory) {
      totals.oom += 1

      if (heapMb < MAX_WORKER_HEAP_MB) {
        heapMb = Math.min(MAX_WORKER_HEAP_MB, Math.round(heapMb * HEAP_BUMP))
        reporter?.print(` ${c.yellow("out of memory:")} ${c.dim(`worker #${worker.index + 1} hit its ${Math.round(heapMb / HEAP_BUMP)} MB heap — restarting the pool at ${heapMb} MB`)}`)
      } else if (poolTarget > 1) {
        // Already at the maximum heap: the only lever left is concurrency.
        poolTarget -= 1
        governor.capTo(poolTarget)
        reporter?.print(` ${c.yellow("out of memory:")} ${c.dim(`worker #${worker.index + 1} died at the ${heapMb} MB ceiling — down to ${plural(poolTarget, "worker")}`)}`)
      }
    }

    if (worker.inFlight.length > 0 || worker.queue.length > 0) {
      totals.crashes.push(`worker #${worker.index + 1}: ${outOfMemory ? "out of memory" : "connection lost"}`)
      requeue(worker)
    }

    maybeFinish()
  }

  /**
   * A worker as the parent sees it: a pid, a socket and whether it stays
   * alive after the run. Messages sent before the socket is up are queued.
   */
  function link(worker, { pid, token, persistent, proc }) {
    const pending = []
    let io = null

    const self = {
      pid,
      token,
      persistent,
      proc,
      socket: null,
      send(message) {
        if (io) {
          io.send(message)
        } else {
          pending.push(message)
        }
      },
      kill(signal) {
        try {
          process.kill(pid, signal)
        } catch {
          // Already gone.
        }
      },
      attach(socket, framed) {
        self.socket = socket
        io = framed
        io.on((message) => onMessage(worker, message))
        socket.on("error", () => {
          // The close that follows is what matters.
        })
        socket.on("close", () => onLost(worker, self))

        for (const message of pending.splice(0)) {
          io.send(message)
        }
      },
    }

    return self
  }

  function spawn(worker) {
    worker.state = "starting"
    worker.started = true
    worker.doneAtStart = worker.done
    lastSpawnAt = Date.now()

    const cacheLocation = options.cache ? workerCacheFile(cwd, worker.index) : undefined

    // A fresh worker starts from a copy of the shared cache. A recycled one
    // keeps the file it already has — it holds this run's results too.
    if (cacheLocation && !fs.existsSync(cacheLocation)) {
      try {
        fs.copyFileSync(path.join(cwd, CACHE_DIR, CACHE_FILE), cacheLocation)
      } catch {
        // No shared cache yet — the worker starts cold and writes one.
      }
    }

    const job = {
      type: "job",
      options: {
        cwd,
        fix: options.fix,
        cache: options.cache,
        cacheLocation,
        cacheStrategy: options.cacheStrategy,
        idleRssBudget: Math.floor((budgetBytes * DAEMON_IDLE_SHARE) / poolSize),
        shard: worker.index,
      },
    }

    // A warm worker first: it already has everything loaded. Preferably the
    // one that served this slot last time, and failing that one whose own
    // slot is not still waiting to be filled.
    const stillCold = (index) => workers.some((other) => other.state === "cold" && !other.child && other.index === index)
    const preferred = [
      adoptable.findIndex((candidate) => candidate.hello.shard === worker.index),
      adoptable.findIndex((candidate) => !stillCold(candidate.hello.shard)),
      0,
    ]
    const chosen = preferred.find((index) => index !== -1)
    const warm = adoptable.length > 0 ? adoptable.splice(chosen, 1)[0] : null

    if (warm) {
      totals.adopted += 1
      worker.child = link(worker, { pid: warm.hello.pid, token: warm.hello.token, persistent: true, proc: null })
      worker.child.attach(warm.socket, warm.io)
      worker.child.send(job)

      return
    }

    const token = crypto.randomUUID()
    const socketPath = path.join(sockets, `w-${token}.sock`)
    // Worker stderr goes to a file, not the terminal: a dying worker prints
    // pages of V8 GC noise, and inheriting it shreds the live view. The
    // file is what tells an out-of-memory death from any other.
    const stderrFd = fs.openSync(path.join(sockets, `w-${token}.stderr`), "w")
    // Only the slots the budget normally runs stay warm; a spare slot the
    // governor opened for a while is not worth a gigabyte of idle heap.
    const persistent = options.daemon && worker.index < poolSize

    const execArgv = [`--max-old-space-size=${heapMb}`]

    if (persistent) {
      // Lets an idle worker hand the job's garbage back to the machine.
      execArgv.push("--expose-gc")
    }

    const proc = childProcess.spawn(process.execPath, [...execArgv, __filename], {
      cwd,
      detached: persistent,
      env: {
        ...process.env,
        CE_WORKER: "1",
        CE_TOKEN: token,
        CE_SOCKET: socketPath,
        CE_EPOCH: epoch,
        CE_HEAP: String(heapMb),
        CE_PERSIST: persistent ? "1" : "0",
      },
      stdio: ["ignore", "ignore", stderrFd],
    })

    fs.closeSync(stderrFd)
    proc.on("error", () => {
      // Never started: the connect below times out and reports it.
    })

    if (persistent) {
      proc.unref()
    }

    const self = link(worker, { pid: proc.pid, token, persistent, proc })

    worker.child = self
    self.send(job)

    connect(socketPath, CONNECT_TIMEOUT_MS)
      .then(({ socket, io }) => {
        if (worker.child !== self) {
          // Given up on meanwhile (killAll): don't leave it hanging.
          socket.destroy()

          return
        }

        self.attach(socket, io)
      })
      .catch(() => {
        onLost(worker, self)
      })
  }

  /**
   * A worker past its share of the memory budget is marked for recycling.
   * Under system-wide pressure the biggest one goes first, whatever its size:
   * shrinking the pool would only make the survivors grow faster.
   */
  function manageMemory() {
    let ours = 0

    for (const worker of workers) {
      worker.rss = worker.child ? processRss(worker.child.pid) : 0
      ours += worker.rss
    }

    totals.ourRss = ours
    totals.peakRss = Math.max(totals.peakRss, ours)
    totals.peakMemory = Math.max(totals.peakMemory, governor.memory)

    if (reporter) {
      reporter.ourRss = ours
    }

    if (!options.safeguard || perWorkerRssBudget <= 0 || Date.now() - lastRecycleAt < RECYCLE_COOLDOWN) {
      return
    }

    // Restarting a worker that has barely begun throws away its warm-up for
    // nothing — it has not had time to grow.
    const eligible = workers.filter((worker) =>
      worker.child && !worker.recycle && worker.done - worker.doneAtStart >= RECYCLE_MIN_FILES)

    if (eligible.length === 0) {
      return
    }

    const fattest = eligible.reduce((worst, worker) => (!worst || worker.rss > worst.rss ? worker : worst), null)

    // Over its own share of the budget: recycle regardless of the machine.
    if (fattest.rss > perWorkerRssBudget) {
      fattest.recycle = true
      lastRecycleAt = Date.now()

      return
    }

    // Otherwise only when the machine is tight AND the memory is largely
    // ours. Recycling cannot free what another process is holding, and doing
    // it anyway just costs throughput.
    const oursDominates = ours > MEMORY_LIMIT * memoryLimit * 0.5

    if (governor.memoryPressure && oursDominates) {
      fattest.recycle = true
      lastRecycleAt = Date.now()
    }
  }

  /** Kill a parked worker to hand its memory back to the machine. */
  function releaseMemory() {
    const victim = workers.find((worker) => worker.state === "parked" && worker.child)

    if (!victim) {
      return
    }

    discard(victim)
    victim.state = "cold"
    totals.killed += 1
  }

  /**
   * Keep exactly as many live workers as the safeguard allows. Spawn one at
   * a time and no faster than SPAWN_INTERVAL, so start-up itself doesn't
   * become the load spike.
   */
  function balance() {
    if (stopped) {
      return
    }

    manageMemory()

    if (governor.holding) {
      // Waiting for the machine to give memory back — and handing ours over
      // while we wait, since idle workers are pure ballast at this point.
      releaseMemory()

      return
    }

    // A parked worker is only worth killing outright once recycling the busy
    // ones has failed to relieve the pressure.
    if (governor.memoryPressure && governor.memoryCount >= MEMORY_WINDOWS) {
      releaseMemory()
    }

    // Waking a worker that already holds a warm ESLint costs nothing, so it
    // is never rate-limited and never gated on the process count — only on
    // how many may run at once.
    for (const worker of workers) {
      if (worker.recycle && worker.child && (worker.state === "parked" || worker.state === "waiting")) {
        dispatch(worker)
      }
    }

    while (activeCount() < governor.limit) {
      const idle = workers.find((worker) => (worker.state === "parked" || worker.state === "waiting") && worker.child)

      if (!idle) {
        break
      }

      dispatch(idle)
    }

    if (activeCount() >= governor.limit) {
      return
    }

    // The first fill goes out in one burst: the pool is sized to fit the
    // budget already, and every second a worker spends loading the config
    // before the next one even starts is a second nobody lints. Later
    // spawns — after a crash or a recycle — are staggered, so a restart
    // wave does not become a load spike of its own. Never hold more live
    // workers than the safeguard allows.
    if (filled && Date.now() - lastSpawnAt < SPAWN_INTERVAL) {
      return
    }

    const burst = !filled
    let live = workers.filter((worker) => worker.child !== null).length

    while (live < governor.limit) {
      const cold = workers.find((worker) => worker.state === "cold" && !worker.child)

      if (!cold || (cold.queue.length === 0 && pendingWork() === 0)) {
        break
      }

      spawn(cold)
      live += 1
      filled = true

      if (!burst) {
        break
      }
    }
  }

  // The governor's tick is also the pool's clock: it re-balances after every
  // sample, which is what un-stalls the pool when the safeguard had stopped
  // every worker.
  governor.start(() => {
    activeSamples += 1
    activeSum += activeCount()

    if (governor.holding) {
      totals.heldMs += SAMPLE_INTERVAL
    }

    if (process.env.CE_DEBUG === "1") {
      const histogram = {}

      for (const worker of workers) {
        histogram[worker.state] = (histogram[worker.state] ?? 0) + 1
      }

      process.stderr.write(`[pool] limit=${governor.limit} active=${activeCount()} live=${workers.filter((w) => w.child).length} pending=${pendingWork()} ${JSON.stringify(histogram)}\n`)
    }

    balance()
  })
  balance()

  const allFiles = await discovery
  const roots = options.paths.map((entry) => path.resolve(cwd, entry))
  const files = roots.length === 0
    ? allFiles
    : allFiles.filter((file) => roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`)))

  const discoveryTime = ((Date.now() - discoveryStart) / 1000).toFixed(1)
  const scope = options.changed ? `changed vs ${options.since ?? "HEAD"}` : "globbed"

  if (files.length === 0) {
    warming = false
    governor.stop()
    await adoption
    killAll()
    const why = options.changed
      ? `nothing changed vs ${options.since ?? "HEAD"}`
      : `config: ${path.basename(configFile)}`

    process.stdout.write(`\n ${c.green(`${DONE_MARK} Nothing to lint`)} ${c.dim(`(${why})`)}\n\n`)

    return
  }

  process.stdout.write(`\n ${c.bold(c.cyan("concurrent-eslint"))}  ${c.dim(`${path.basename(configFile)} · ${scope} in ${discoveryTime}s`)}\n`)
  process.stdout.write(` ${c.dim(`${plural(files.length, "file")} · ${plural(threads, "worker")} · ${plural(cores, "core")} · ${workerHeapMb} MB heap per worker${flags ? ` · ${flags}` : ""}`)}\n`)

  if (overcommitted) {
    process.stdout.write(` ${c.yellow("memory:")} ${c.dim(`only ${(availableBytes / 1073741824).toFixed(1)}G of the ${budgetGb}G budget is free — the pool will wait for room before it starts`)}\n`)
  } else if (memoryBound) {
    process.stdout.write(` ${c.yellow("memory-bound:")} ${c.dim(`a ${budgetGb}G budget holds ${plural(affordableWorkers, "worker")} at ~${WORKER_RSS_ESTIMATE_MB} MB each, CPU would allow ${expectedWorkers}`)}\n`)
  }

  if (!options.safeguard) {
    process.stdout.write(` ${c.red("safeguard off")} ${c.dim("— nothing will stop this from taking the machine down")}\n`)
  } else if (threads < requested) {
    process.stdout.write(` ${c.yellow("safeguard:")} ${c.dim(`${plural(requested, "worker")} requested, running ${Math.min(threads, poolSize)} of ${threads} slots (CPU ≤ ${options.maxCpu}%, RAM ≤ ${options.maxMemory}% = ${budgetGb}G of ${totalGb}G)`)}\n`)
  } else {
    process.stdout.write(` ${c.dim(`safeguard: running ${Math.min(threads, poolSize)} of ${threads} slots · CPU ≤ ${options.maxCpu}%, RAM ≤ ${options.maxMemory}% = ${budgetGb}G of ${totalGb}G`)}\n`)
  }

  /* --- worker pool --------------------------------------------------- */
  // Deal into the number of workers that will actually run, not into every
  // slot. Sharding across slots the safeguard will never open just means the
  // running workers have to steal it all back one empty queue at a time.
  // Spinning up a worker that will lint three files is a net loss.
  await adoption

  const usefulWorkers = Math.max(1, Math.ceil(files.length / FILES_PER_WORKER))

  governor.capTo(usefulWorkers)

  const shardCount = Math.max(1, Math.min(
    options.safeguard ? Math.min(threads, poolSize) : threads,
    usefulWorkers,
    files.length,
  ))

  batchSize = Math.max(1, Math.min(8, Math.ceil(files.length / shardCount / 10)))

  shard(files, shardCount).forEach((queue, index) => {
    workers[index].queue = queue
    workers[index].assigned = queue.length
  })

  reporter = new Reporter({
    palette: c,
    workers,
    total: files.length,
    governor,
    stream: process.stdout,
    headless: options.headless,
  })

  warming = false
  governor.settle()
  reporter.start()

  for (const worker of workers) {
    if (worker.state === "waiting") {
      dispatch(worker)
    }
  }

  // Nothing could be spawned while the queues were empty; fill the pool now
  // rather than on the governor's next tick.
  balance()
  maybeFinish()

  await run

  reporter.stop()

  const cacheRefreshed = options.cache ? mergeCache(cwd) : 0

  /* --- summary ------------------------------------------------------ */

  const seconds = reporter.elapsed()
  const shownWarnings = options.quiet ? 0 : totals.warnings
  const problems = totals.errors + shownWarnings
  const paint = totals.errors > 0 ? c.red : c.green

  process.stdout.write(` ${paint("─".repeat(Math.min(64, (process.stdout.columns || 80) - 2)))}\n`)

  if (problems === 0) {
    process.stdout.write(` ${c.green(`${DONE_MARK} clean`)}  ${c.dim(plural(files.length - totals.ignored, "file"))}\n`)
  } else {
    process.stdout.write([
      ` ${paint(`${totals.errors > 0 ? "✖" : "⚠"} ${plural(problems, "problem")}`)}`,
      c.red(plural(totals.errors, "error")),
      c.yellow(plural(shownWarnings, "warning")),
      `${c.dim(`in ${totals.filesWithProblems} of ${plural(files.length - totals.ignored, "file")}`)}\n`,
    ].join("  "))
  }

  if (options.fix && totals.fixedFiles > 0) {
    process.stdout.write(` ${c.magenta(`✎ ${plural(totals.fixedFiles, "file")} fixed`)}  ${c.dim(`${plural(totals.fixedLines, "line")} rewritten`)}\n`)
  }

  if (!options.fix && totals.fixableErrors + totals.fixableWarnings > 0) {
    process.stdout.write(` ${c.dim(`${totals.fixableErrors + totals.fixableWarnings} fixable with --fix`)}\n`)
  }

  // When memory got tight, say whose memory it was — throttling ourselves
  // does nothing about a machine that is full of something else.
  if (totals.peakMemory > memoryLimit) {
    const share = totals.peakMemory > 0 ? totals.peakRss / MEMORY_LIMIT / totals.peakMemory : 0

    process.stdout.write([
      ` ${c.yellow("memory pressure:")}`,
      c.dim(`peaked at ${Math.round(totals.peakMemory * 100)}% of ${(MEMORY_LIMIT / 1073741824).toFixed(0)}G,`),
      c.dim(`${(totals.peakRss / 1073741824).toFixed(1)}G of it ours (${Math.round(share * 100)}%)`),
      c.dim(share < 0.5 ? "— most of it is something else on this machine\n" : `— ${plural(totals.recycled, "worker")} recycled\n`),
    ].join(" "))
  }

  if (totals.crashes.length > 0) {
    process.stdout.write(` ${c.yellow(`${plural(totals.crashes.length, "worker")} restarted`)} ${c.dim(`(${totals.crashes.slice(0, 3).join(", ")}${totals.crashes.length > 3 ? "…" : ""}) — their files were picked up by the rest`)}\n`)
  }

  for (const failure of totals.failures) {
    process.stdout.write(` ${c.red("failed:")} ${c.dim(`${failure.file}: ${failure.error}`)}\n`)
  }

  const perSecond = seconds > 0 ? (files.length / seconds).toFixed(0) : files.length
  const averageActive = activeSamples > 0 ? activeSum / activeSamples : threads
  if (totals.heldMs > 0) {
    process.stdout.write([
      ` ${c.yellow("memory hold:")}`,
      c.dim(`${(totals.heldMs / 1000).toFixed(0)}s spent waiting for RAM to come back`),
      c.dim(governor.holdExpired ? "— it never did, so the run went ahead anyway\n" : "\n"),
    ].join(" "))
  }

  const safeguardNote = totals.parked + totals.killed > 0
    ? ` · safeguard: ${totals.parked} parked, ${totals.killed} stopped${totals.recycled > 0 ? `, ${totals.recycled} recycled` : ""}`
    : (totals.recycled > 0 ? ` · safeguard: ${totals.recycled} recycled` : "")
  const stealNote = totals.rebalanced > 0 ? ` · ${plural(totals.rebalanced, "file")} rebalanced` : ""
  const warmNote = totals.adopted > 0 || options.daemon ? ` · ${totals.adopted} warm` : ""
  // A file that produced no result — lint failed, or it crashed its worker
  // for good — was neither a hit nor a miss.
  const checked = files.length - totals.ignored - totals.failures.length
  const cacheNote = options.cache && checked > 0 ? ` · cache hits ${Math.max(0, checked - cacheRefreshed)}/${checked}` : ""

  process.stdout.write(` ${c.dim(`${seconds.toFixed(1)}s · ${averageActive.toFixed(1)}/${threads} workers busy on average · ~${perSecond} files/s · CPU ${Math.round(governor.cpu * 100)}% · RAM ${Math.round(governor.memory * 100)}%${safeguardNote}${stealNote}${cacheNote}${warmNote}`)}\n\n`)

  const tooManyWarnings = options.maxWarnings >= 0 && totals.warnings > options.maxWarnings

  if (totals.errors > 0 || totals.failures.length > 0 || tooManyWarnings) {
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ */

if (process.env.CE_WORKER === "1") {
  try {
    runWorker()
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`)
    process.exit(1)
  }
} else {
  main().catch((error) => {
    process.stdout.write(`${ESC}[?25h`)
    process.stderr.write(`${error?.stack || error}\n`)
    process.exit(2)
  })
}
