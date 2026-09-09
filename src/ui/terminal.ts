/**
 * ANSI colors and width-aware text helpers. Everything the live view prints
 * goes through here so that padding and truncation ignore escape sequences.
 */

import { bar } from "../constants.ts"

/** The escape character. */
export const ESC = String.fromCharCode(27)
/** Resets every attribute. */
export const RESET = `${ESC}[0m`

/** Colors; every paint is a no-op when disabled. */
export const palette = (enabled: boolean): Ui.Palette => {
    const wrap = (open: number | string, close: number): Ui.Paint => (s) =>
        (enabled ? `${ESC}[${open}m${s}${ESC}[${close}m` : String(s))

    return {
        enabled,
        red: wrap(31, 39),
        green: wrap(32, 39),
        yellow: wrap(33, 39),
        cyan: wrap(36, 39),
        magenta: wrap(35, 39),
        // 256-color: the 16-color palette has no orange.
        orange: wrap("38;5;208", 39),
        gray: wrap(90, 39),
        bold: wrap(1, 22),
        dim: wrap(2, 22),
        underline: wrap(4, 24),
    }
}

/** Matches one SGR escape sequence. */
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g")

/** Width-aware text helpers. */
export const text = {
    /** Drop every escape sequence. */
    strip(s: string | number): string {
        return String(s).replace(ANSI, "")
    },

    /** Visible characters, escape sequences not counted. */
    width(s: string | number): number {
        return this.strip(s).length
    },

    /** Truncate by visible characters, keeping ANSI sequences intact. */
    cut(s: string | number, limit: number): string {
        if (limit <= 0) {
            return ""
        }

        const source = String(s)

        if (this.width(source) <= limit) {
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
    },

    /** Left-aligned in a column of `width`. */
    left(s: string | number, width: number): string {
        const diff = width - this.width(s)

        return diff > 0 ? `${s}${" ".repeat(diff)}` : String(s)
    },

    /** Right-aligned in a column of `width`. */
    right(s: string | number, width: number): string {
        const diff = width - this.width(s)

        return diff > 0 ? `${" ".repeat(diff)}${s}` : String(s)
    },

    /** "1 file" / "2 files" — counts show up all over the summary. */
    plural(count: number, one: string, many = `${one}s`): string {
        return `${count} ${count === 1 ? one : many}`
    },

    /** A braille progress bar: `done` of `total`, `width` cells wide. */
    bar(done: number, total: number, width = bar.width): string {
        const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0
        const filled = Math.round(ratio * width * bar.steps)
        let out = ""

        for (let cell = 0; cell < width; cell++) {
            const level = Math.min(bar.steps, Math.max(0, filled - cell * bar.steps))

            out += bar.cells[level]
        }

        return out
    },
}
