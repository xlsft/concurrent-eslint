// Build: tsc, then ship the ambient type declarations.
//
// types/*.d.ts are global namespaces (Cli, Files, System, Ui, Workers) that
// tsc type-checks against but never emits. The published declarations mention
// them (`Cli.RunOptions` in run.d.ts, for one), so they are copied into
// dist/types and referenced from dist/index.d.ts — tsc drops triple-slash
// references from its output, hence the prepend here.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

/** The repository. */
const root = path.resolve(import.meta.dirname, "..")
/** Where tsc emits. */
const dist = path.join(root, "dist")
/** The ambient declarations. */
const types = path.join(root, "types")

fs.rmSync(dist, { recursive: true, force: true })
execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" })

fs.mkdirSync(path.join(dist, "types"), { recursive: true })

/** Declaration files to ship, in reference order. */
const names = fs.readdirSync(types).filter((name) => name.endsWith(".d.ts")).sort()

for (const name of names) {
    fs.copyFileSync(path.join(types, name), path.join(dist, "types", name))
}

/** The published entry declaration. */
const entry = path.join(dist, "index.d.ts")
/** One triple-slash reference per declaration file. */
const references = names.map((name) => `/// <reference path="./types/${name}" />`).join("\n")

fs.writeFileSync(entry, `${references}\n${fs.readFileSync(entry, "utf8")}`)
process.stdout.write(`dist/: ${names.length} ambient declaration files referenced from index.d.ts\n`)
