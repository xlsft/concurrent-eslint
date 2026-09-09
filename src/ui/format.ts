/**
 * One file's problems, as a block: the path underlined, then a row per
 * message with position, severity, text and rule.
 */

import path from "node:path"

import { text } from "./terminal.ts"

/** Render one file's problems, or null when there is nothing to show. */
export const format = (result: Workers.Result, { cwd, palette: c, quiet, headless, columns }: Ui.FormatOptions): string | null => {
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

    const positions = Math.max(...rows.map((row) => row.position.length))
    const longest = Math.max(...rows.map((row) => row.text.length))
    // A CI log has no width to fit: never cut a rule message there.
    const width = headless
        ? longest
        : Math.min(longest, Math.max(40, (columns ?? process.stdout.columns ?? 120) - positions - 34))

    const body = rows
        .map((row) => [
            `  ${c.dim(text.left(row.position, positions))}`,
            row.severity,
            text.left(text.cut(row.text, width), width),
            c.dim(row.rule),
        ].join("  "))
        .join("\n")

    return `${c.underline(c.bold(relative))}\n${body}`
}
