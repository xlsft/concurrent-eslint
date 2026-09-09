import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { palette, text } from "../src/ui/terminal.ts"

describe("palette", () => {
    it("wraps text in escape sequences when enabled", () => {
        const c = palette(true)

        assert.equal(text.strip(c.red("x")), "x")
        assert.notEqual(c.red("x"), "x")
        assert.equal(text.width(c.bold(c.red("abc"))), 3)
    })

    it("is a no-op when disabled", () => {
        const c = palette(false)

        assert.equal(c.red("x"), "x")
        assert.equal(c.dim(42), "42")
    })
})

describe("text.cut", () => {
    it("keeps short text as is", () => {
        assert.equal(text.cut("hello", 10), "hello")
    })

    it("cuts by visible width and keeps escape sequences", () => {
        const c = palette(true)
        const cut = text.cut(c.red("hello world"), 6)

        assert.equal(text.strip(cut), "hello…")
        assert.ok(cut.includes("[31m"))
    })

    it("returns nothing for a zero width", () => {
        assert.equal(text.cut("hello", 0), "")
    })
})

describe("text.left / text.right", () => {
    it("pads by visible width", () => {
        const c = palette(true)

        assert.equal(text.width(text.left(c.red("ab"), 5)), 5)
        assert.equal(text.width(text.right(c.red("ab"), 5)), 5)
        assert.equal(text.right(7, 3), "  7")
        assert.equal(text.left("ab", 4), "ab  ")
    })
})

describe("text.plural", () => {
    it("picks the form by count", () => {
        assert.equal(text.plural(1, "file"), "1 file")
        assert.equal(text.plural(2, "file"), "2 files")
        assert.equal(text.plural(0, "entry", "entries"), "0 entries")
    })
})

describe("text.bar", () => {
    it("is empty at zero and full at the end", () => {
        assert.equal(text.bar(0, 10, 4), "⠀⠀⠀⠀")
        assert.equal(text.bar(10, 10, 4), "⣿⣿⣿⣿")
    })

    it("fills left to right", () => {
        assert.equal(text.bar(1, 2, 2), "⣿⠀")
    })

    it("handles an empty total", () => {
        assert.equal(text.bar(0, 0, 3), "⠀⠀⠀")
    })
})
