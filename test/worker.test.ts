import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { worker } from "../src/workers/worker.ts"

describe("worker.diff", () => {
    it("counts lines that differ", () => {
        assert.equal(worker.diff("a\nb\nc", "a\nB\nc"), 1)
        assert.equal(worker.diff("a\nb", "a\nb\nc"), 1)
        assert.equal(worker.diff("same", "same"), 0)
    })
})
