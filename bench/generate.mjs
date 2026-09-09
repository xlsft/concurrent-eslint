// A deterministic synthetic TypeScript corpus for the benchmark: N files in
// nested directories, each importing a few siblings, with a lint problem in
// every tenth file. Usage: node bench/generate.mjs <dir> <count>
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

/** Output directory and file count, from argv. */
const [, , out, countArg] = process.argv
/** How many files to write. */
const count = Number(countArg)
/** Seed of the tiny LCG below; fixed so every run produces the same corpus. */
let seed = 42
/** A pseudo-random number in [0, 1). */
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
/** A random element. */
const pick = (list) => list[Math.floor(rand() * list.length)]

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, "src"), { recursive: true })

/** Every file: directory, name and index. */
const files = Array.from({ length: count }, (_unused, index) => ({
    dir: `src/mod${Math.floor(index / 40)}/${["core", "ui", "api"][index % 3]}`,
    name: `file${index}`,
    index,
}))

for (const { dir, name, index } of files) {
    fs.mkdirSync(path.join(out, dir), { recursive: true })

    const imports = Array.from({ length: 3 }, () => pick(files)).filter((other) => other.index !== index)
    const lines = [
        `/** Module ${index}. */`,
        ...imports.map((other, k) => `import { value${other.index} as dep${k} } from "${path.relative(dir, other.dir) || "."}/${other.name}.ts"`),
        "",
        `export interface Shape${index} {`,
        "    id: number",
        "    label: string",
        "    tags: string[]",
        "    nested?: { depth: number; items: Array<{ key: string; weight: number }> }",
        "}",
        "",
        `export const value${index} = ${index}`,
        "",
        `export class Model${index} {`,
        `    private readonly items = new Map<number, Shape${index}>()`,
        "",
        `    constructor(private readonly prefix: string = "m${index}") {}`,
        "",
        `    add(shape: Shape${index}): this {`,
        "        this.items.set(shape.id, { ...shape, label: `${this.prefix}:${shape.label}` })",
        "        return this",
        "    }",
        "",
        `    find(predicate: (shape: Shape${index}) => boolean): Shape${index} | undefined {`,
        "        for (const shape of this.items.values()) {",
        "            if (predicate(shape)) {",
        "                return shape",
        "            }",
        "        }",
        "        return undefined",
        "    }",
        "",
        "    weights(): number[] {",
        "        return [...this.items.values()].flatMap((s) => s.nested?.items.map((i) => i.weight) ?? [])",
        "    }",
        "}",
        "",
    ]

    for (let f = 0; f < 12; f++) {
        lines.push(
            `export const fn${index}_${f} = (input: number[], factor = ${f + 1}): { sum: number; max: number; text: string } => {`,
            "    let sum = 0",
            "    let max = Number.NEGATIVE_INFINITY",
            "    for (const n of input) {",
            `        const scaled = n * factor + ${imports.length > 0 ? "dep0" : "1"}`,
            "        sum += scaled",
            "        if (scaled > max) {",
            "            max = scaled",
            "        }",
            "    }",
            "    const text = input.length > 3 ? `many:${sum}` : input.length === 0 ? \"none\" : `few:${max}`",
            `    return { sum: sum + ${imports.length > 1 ? "dep1" : "0"}, max, text }`,
            "}",
            "",
        )
    }

    if (index % 10 === 0) {
        lines.push("const unusedLocal = 1", "")
    }

    if (index % 7 === 0) {
        lines.push(`export const loose${index}: any = { ok: true }`, "")
    }

    lines.push(`export default { value${index}, Model${index}${imports.length > 2 ? ", dep2" : ""} }`, "")
    fs.writeFileSync(path.join(out, dir, `${name}.ts`), lines.join("\n"))
}

fs.writeFileSync(path.join(out, "eslint.config.js"), `import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"

export default defineConfig([
    { ignores: ["node_modules/**"] },
    js.configs.recommended,
    tseslint.configs.recommended,
])
`)
fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify({ name: "bench-corpus", private: true, type: "module" }, null, 2)}\n`)
process.stdout.write(`${count} files in ${out}\n`)
