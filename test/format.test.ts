import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { format } from "../src/ui/format.ts"
import { palette } from "../src/ui/terminal.ts"

const c = palette(false)
const result: Workers.Result = {
    filePath: "/project/src/a.ts",
    errorCount: 1,
    warningCount: 1,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    fixedLines: 0,
    messages: [
        { line: 3, column: 5, severity: 2, message: "Unexpected   thing", ruleId: "no-thing" },
        { line: 10, column: 1, severity: 1, message: "Careful", ruleId: "be-careful" },
    ],
}

describe("format", () => {
    it("renders a block with a relative path and one row per message", () => {
        const block = format(result, { cwd: "/project", palette: c, quiet: false, headless: true })

        assert.ok(block)
        assert.ok(block.startsWith("src/a.ts\n"))
        assert.match(block, /3:5\s+error\s+Unexpected thing\s+no-thing/)
        assert.match(block, /10:1\s+warning\s+Careful\s+be-careful/)
    })

    it("drops warnings under --quiet", () => {
        const block = format(result, { cwd: "/project", palette: c, quiet: true, headless: true })

        assert.ok(block)
        assert.doesNotMatch(block, /warning/)
    })

    it("returns null when nothing is left to show", () => {
        assert.equal(format({ ...result, messages: [] }, { cwd: "/project", palette: c, quiet: false, headless: true }), null)
    })

    it("truncates long messages to the terminal width unless headless", () => {
        const long = { ...result, messages: [{ ...result.messages[0], message: "x".repeat(200) }] }
        const narrow = format(long, { cwd: "/project", palette: c, quiet: false, headless: false, columns: 80 })
        const wide = format(long, { cwd: "/project", palette: c, quiet: false, headless: true })

        assert.ok(narrow && narrow.includes("…"))
        assert.ok(wide && !wide.includes("…"))
    })
})
