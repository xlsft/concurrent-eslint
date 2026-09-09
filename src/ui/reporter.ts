/**
 * The live view: a block at the bottom of the terminal redrawn a few times
 * a second, with problems printed above it as they come in.
 */

import { bar, guard } from "../constants.ts"
import { ESC, RESET, text } from "./terminal.ts"

/** The live view, and the one place problems are printed through. */
export class Reporter {
    /** Resident size of our workers, for the RAM gauge. */
    rss = 0
    /** Whether the live block is drawn at all. */
    readonly live: boolean
    /** Colors. */
    private readonly c: Ui.Palette
    /** The slots to draw, one line each. */
    private readonly workers: Workers.Slot[]
    /** Files in the run, for the overall bar. */
    private readonly total: number
    /** The safeguard, for the gauges. */
    private readonly governor: System.GovernorState
    /** Where to draw. */
    private readonly stream: NodeJS.WriteStream
    /** Lines of the live block currently on screen. */
    private rendered = 0
    /** Spinner frame counter. */
    private frame = 0
    /** When the reporter was created. */
    private readonly started = Date.now()
    /** The redraw interval, while live. */
    private timer: NodeJS.Timeout | null = null

    /** Live only on a TTY and not under --headless. */
    constructor({ palette, workers, total, governor, stream, headless }: Ui.ReporterOptions) {
        this.c = palette
        this.workers = workers
        this.total = total
        this.governor = governor
        this.stream = stream
        this.live = stream.isTTY === true && headless !== true
    }

    /** Terminal width, with a sane fallback. */
    width(): number {
        return this.stream.columns && this.stream.columns > 20 ? this.stream.columns : 120
    }

    /** Hide the cursor and start redrawing. */
    start(): void {
        if (!this.live) {
            return
        }

        this.stream.write(`${ESC}[?25l`)
        this.timer = setInterval(() => {
            this.frame += 1
            this.render()
        }, 80)
        this.timer.unref()
    }

    /** Draw the final frame and show the cursor again. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }

        if (this.live) {
            this.render()
            this.stream.write(`${ESC}[?25h`)
        }
    }

    /** Erase the live block. */
    clear(): void {
        if (!this.live || this.rendered === 0) {
            return
        }

        this.stream.write(`${ESC}[${this.rendered}A${ESC}[0J`)
        this.rendered = 0
    }

    /** Print above the live block: erase it, write, then redraw. */
    print(s: string): void {
        this.clear()
        this.stream.write(`${s}\n`)
        this.render()
    }

    /** Seconds since the reporter was created. */
    elapsed(): number {
        return (Date.now() - this.started) / 1000
    }

    /** A labelled bar with a percentage, colored by distance to the limit. */
    private gauge(label: string, value: number, limit: number, note?: string): string {
        const c = this.c
        const paint: Ui.Paint = value > limit ? c.red : value > limit - 0.15 ? c.yellow : c.green
        const suffix = note ? ` ${c.dim(note)}` : ""

        return `${c.dim(label)} ${paint(text.bar(value, 1, 8))} ${paint(text.right(`${Math.round(value * 100)}%`, 4))}${suffix}`
    }

    /** One worker's line: spinner, bar, counters, stats and label. */
    private line(worker: Workers.Slot, index: number): string {
        const c = this.c
        // One error anywhere turns the whole block red; green otherwise.
        const paint: Ui.Paint = worker.errors > 0 ? c.red : c.green
        const marks: Partial<Record<Workers.State, string>> = {
            done: bar.done,
            parked: bar.parked,
            cold: bar.cold,
        }
        const spinner = marks[worker.state] ?? bar.spinner[(this.frame + index * 3) % bar.spinner.length]
        const id = String(index + 1).padStart(2, "0")
        const progress = text.bar(worker.done, Math.max(worker.assigned, 1))
        const counter = `${text.right(worker.done, String(this.total).length)}/${worker.assigned}`
        const stats: string[] = []

        if (worker.errors > 0) {
            stats.push(c.red(`✖ ${worker.errors}`))
        }

        if (worker.warnings > 0) {
            stats.push(c.yellow(`⚠ ${worker.warnings}`))
        }

        if (worker.lines > 0) {
            stats.push(c.magenta(`✎ ${worker.lines}`))
        }

        // Work stealing: ↙ took files off another worker, ↗ handed its own away.
        // Without this the denominators look like they drift for no reason.
        if (worker.stolen > 0) {
            stats.push(c.cyan(`↙ ${worker.stolen}`))
        }

        if (worker.reassigned > 0) {
            stats.push(c.dim(`↗ ${worker.reassigned}`))
        }

        const labels: Partial<Record<Workers.State, string>> = {
            done: c.dim(worker.errors > 0 ? "done, with errors" : "done"),
            parked: c.yellow("parked — safeguard"),
            waiting: c.dim("warm, waiting for files"),
            // A slot the safeguard never had budget for is spare capacity, not a
            // casualty: its files are stolen by the workers that did run.
            cold: c.dim(worker.reassigned > 0
                ? `${worker.started ? "stopped" : "spare"} — ${text.plural(worker.reassigned, "file")} reassigned`
                : (worker.started ? "stopped — safeguard" : "spare — no budget")),
            starting: c.dim("starting…"),
        }
        const head = `${paint(spinner)} ${c.dim(id)} ${paint(progress)} ${paint(text.left(counter, 10))}`
        const tail = stats.length > 0 ? `${stats.join(" ")} ` : ""
        const label = labels[worker.state] ?? c.dim(worker.current || "…")
        const used = text.width(head) + text.width(tail) + 2

        return ` ${head}${tail}${text.cut(label, this.width() - used)}`
    }

    /** Redraw the whole live block. */
    render(): void {
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
        const paint: Ui.Paint = errors > 0 ? c.red : c.green
        const lines = [""]

        lines.push([
            ` ${paint(text.bar(done, this.total, 24))}`,
            c.bold(text.right(`${percent}%`, 4)),
            c.dim(`${done}/${this.total}`),
            ` ${c.red(`✖ ${errors}`)}`,
            c.yellow(`⚠ ${warnings}`),
            c.dim(`${this.elapsed().toFixed(1)}s`),
        ].join("  "))

        lines.push([
            ` ${this.gauge("CPU", governor.cpu, governor.cpuLimit)}`,
            this.gauge("RAM", governor.memory, governor.memoryLimit, this.rss > 0 ? `(${(this.rss / 1073741824).toFixed(1)}G ours)` : ""),
            c.dim(`workers ${active}/${governor.limit}`),
            governor.holding
                ? c.red(`held — waiting for RAM to drop below ${Math.round((governor.memoryLimit - guard.ram.margin) * 100)}%`)
                : governor.throttled ? c.yellow("safeguard holding back") : c.dim(""),
        ].join("  ").trimEnd())

        lines.push("")

        for (const [index, worker] of this.workers.entries()) {
            lines.push(this.line(worker, index))
        }

        lines.push("")

        const width = this.width()
        const body = lines
            .map((line) => (c.enabled ? `${text.cut(line, width)}${RESET}` : text.cut(line, width)))
            .join("\n")

        this.stream.write(`${body}\n`)
        this.rendered = lines.length
    }
}
