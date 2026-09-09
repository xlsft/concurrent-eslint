/**
 * The lines after the run: problem counts, what the safeguard did, and
 * the exit code.
 */

import { bar } from "../constants.ts"
import { ram } from "../system/resources.ts"
import { text } from "../ui/terminal.ts"

/** Prints the summary and returns the exit code. */
export const summary = ({ palette: c, options, plan, totals, governor, files, seconds, average, refreshed, columns }: Cli.Summary): number => {
    const out = (s: string): void => {
        process.stdout.write(s)
    }
    const { plural } = text
    const warnings = options.quiet ? 0 : totals.warnings
    const problems = totals.errors + warnings
    const paint = totals.errors > 0 ? c.red : c.green
    const checked = files - totals.ignored

    out(` ${paint("─".repeat(Math.min(64, (columns ?? process.stdout.columns ?? 80) - 2)))}\n`)

    if (problems === 0) {
        out(` ${c.green(`${bar.done} clean`)}  ${c.dim(plural(checked, "file"))}\n`)
    } else {
        out([
            ` ${paint(`${totals.errors > 0 ? "✖" : "⚠"} ${plural(problems, "problem")}`)}`,
            c.red(plural(totals.errors, "error")),
            c.yellow(plural(warnings, "warning")),
            `${c.dim(`in ${totals.problematic} of ${plural(checked, "file")}`)}\n`,
        ].join("  "))
    }

    if (options.fix && totals.fixed > 0) {
        out(` ${c.magenta(`✎ ${plural(totals.fixed, "file")} fixed`)}  ${c.dim(`${plural(totals.lines, "line")} rewritten`)}\n`)
    }

    if (!options.fix && totals.fixableErrors + totals.fixableWarnings > 0) {
        out(` ${c.dim(`${totals.fixableErrors + totals.fixableWarnings} fixable with --fix`)}\n`)
    }

    // When memory got tight, say whose memory it was — throttling ourselves
    // does nothing about a machine that is full of something else.
    if (totals.peakMemory > plan.memoryLimit) {
        const share = totals.peakMemory > 0 ? totals.peakRss / ram / totals.peakMemory : 0

        out([
            ` ${c.yellow("memory pressure:")}`,
            c.dim(`peaked at ${Math.round(totals.peakMemory * 100)}% of ${(ram / 1073741824).toFixed(0)}G,`),
            c.dim(`${(totals.peakRss / 1073741824).toFixed(1)}G of it ours (${Math.round(share * 100)}%)`),
            c.dim(share < 0.5 ? "— most of it is something else on this machine\n" : `— ${plural(totals.recycled, "worker")} recycled\n`),
        ].join(" "))
    }

    if (totals.crashes.length > 0) {
        out(` ${c.yellow(`${plural(totals.crashes.length, "worker")} restarted`)} ${c.dim(`(${totals.crashes.slice(0, 3).join(", ")}${totals.crashes.length > 3 ? "…" : ""}) — their files were picked up by the rest`)}\n`)
    }

    for (const failure of totals.failures) {
        out(` ${c.red("failed:")} ${c.dim(`${failure.file}: ${failure.error}`)}\n`)
    }

    if (totals.held > 0) {
        out([
            ` ${c.yellow("memory hold:")}`,
            c.dim(`${(totals.held / 1000).toFixed(0)}s spent waiting for RAM to come back`),
            c.dim(governor.expired ? "— it never did, so the run went ahead anyway\n" : "\n"),
        ].join(" "))
    }

    const rate = seconds > 0 ? (files / seconds).toFixed(0) : String(files)
    const safeguard = totals.parked + totals.killed > 0
        ? ` · safeguard: ${totals.parked} parked, ${totals.killed} stopped${totals.recycled > 0 ? `, ${totals.recycled} recycled` : ""}`
        : (totals.recycled > 0 ? ` · safeguard: ${totals.recycled} recycled` : "")
    const stolen = totals.rebalanced > 0 ? ` · ${plural(totals.rebalanced, "file")} rebalanced` : ""
    const adopted = totals.adopted > 0 || options.daemon ? ` · ${totals.adopted} warm` : ""
    // A file that produced no result — lint failed, or it crashed its worker
    // for good — was neither a hit nor a miss.
    const hits = checked - totals.failures.length
    const cache = options.cache && hits > 0 ? ` · cache hits ${Math.max(0, hits - refreshed)}/${hits}` : ""

    out(` ${c.dim(`${seconds.toFixed(1)}s · ${average.toFixed(1)}/${plan.threads} workers busy on average · ~${rate} files/s · CPU ${Math.round(governor.cpu * 100)}% · RAM ${Math.round(governor.memory * 100)}%${safeguard}${stolen}${cache}${adopted}`)}\n\n`)

    const tooMany = options.maxWarnings >= 0 && totals.warnings > options.maxWarnings

    return totals.errors > 0 || totals.failures.length > 0 || tooMany ? 1 : 0
}
