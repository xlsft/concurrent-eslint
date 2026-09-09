#!/usr/bin/env node
import { run } from "./cli/run.ts"
import { ESC } from "./ui/terminal.ts"

run(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code
    })
    .catch((error: unknown) => {
        process.stdout.write(`${ESC}[?25h`)
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
        process.exit(2)
    })
