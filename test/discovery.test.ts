import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"

import { files } from "../src/files/discovery.ts"

describe("files.shard", () => {
    it("slices contiguously and covers everything", () => {
        const list = ["a", "b", "c", "d", "e"]
        const parts = files.shard(list, 2)

        assert.deepEqual(parts, [["a", "b"], ["c", "d", "e"]])
        assert.deepEqual(parts.flat(), list)
    })

    it("leaves empty shards when there are more workers than files", () => {
        assert.deepEqual(files.shard(["a"], 3), [[], [], ["a"]])
    })
})

describe("files.walk", () => {
    const dirs: string[] = []

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("walks the tree, skips the hard skips and sorts", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-test-"))

        dirs.push(dir)
        fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true })
        fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true })
        fs.writeFileSync(path.join(dir, "src", "b.ts"), "")
        fs.writeFileSync(path.join(dir, "src", "a.js"), "")
        fs.writeFileSync(path.join(dir, "src", "deep", "c.vue"), "")
        fs.writeFileSync(path.join(dir, "src", "readme.md"), "")
        fs.writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "")

        const ticks: number[] = []
        const found = await files.walk({ cwd: dir, extensions: ["js", "ts", "vue"], tick: (n) => ticks.push(n) })

        assert.deepEqual(found.map((file) => path.relative(dir, file)), ["src/a.js", "src/b.ts", "src/deep/c.vue"])
        assert.deepEqual(ticks, [1, 2, 3])
    })

    it("finds the config file", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-test-"))

        dirs.push(dir)
        assert.equal(await files.config(dir), null)
        fs.writeFileSync(path.join(dir, "eslint.config.mjs"), "export default []")
        assert.equal(await files.config(dir), path.join(dir, "eslint.config.mjs"))
    })
})
