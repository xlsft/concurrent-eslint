/**
 * Terminal output: colors, the live view and problem formatting.
 * Ambient — available everywhere without an import.
 */
declare namespace Ui {
    /** Wraps text in a color; a no-op when colors are off. */
    type Paint = (text: string | number) => string

    /** The colors the output is painted with. */
    interface Palette {
        /** Whether any paint does anything. */
        enabled: boolean
        /** Errors. */
        red: Paint
        /** Clean. */
        green: Paint
        /** Warnings and safeguard notes. */
        yellow: Paint
        /** The tool's name and stolen-file counts. */
        cyan: Paint
        /** Fixes. */
        magenta: Paint
        /** Secondary text in the help. */
        gray: Paint
        /** Emphasis. */
        bold: Paint
        /** Secondary text. */
        dim: Paint
        /** File paths above a problem block. */
        underline: Paint
    }

    /** What the live view is built from. */
    interface ReporterOptions {
        /** Colors. */
        palette: Palette
        /** The slots to draw, one line each. */
        workers: Workers.Slot[]
        /** Files in the run, for the overall bar. */
        total: number
        /** The safeguard, for the gauges. */
        governor: System.GovernorState
        /** Where to draw; only a TTY gets the live block. */
        stream: NodeJS.WriteStream
        /** Never draw the live block, even on a TTY. */
        headless: boolean
    }

    /** How a problem block is rendered. */
    interface FormatOptions {
        /** Paths are shown relative to this. */
        cwd: string
        /** Colors. */
        palette: Palette
        /** Errors only. */
        quiet: boolean
        /** Never truncate a message to the terminal width. */
        headless: boolean
        /** Terminal width; defaults to stdout's. */
        columns?: number
    }
}
