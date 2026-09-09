# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`concurrent-eslint` is a multi-process ESLint runner published to npm as an ESM CLI (`bin: dist/cli.js`) with a small programmatic API (`dist/index.js`). ESLint itself is a **peer dependency** resolved from the project being linted, never from this package.

## Commands

```bash
npm run check        # typecheck + lint + docs + test — run before finishing any change
npm run typecheck    # tsc -p tsconfig.json (noEmit; covers src, types, test, scripts)
npm run lint         # runs THIS tool on THIS repo from the sources: node src/cli.ts --headless --no-daemon
npm run docs         # JSDoc coverage; must stay at 100% (scripts/jsdoc.mjs)
npm test             # node --test test/*.test.ts
node --test test/options.test.ts                       # one test file
node --test --test-name-pattern="daemon" test/*.test.ts # tests matching a name
npm run build        # scripts/build.mjs: rm dist, tsc -p tsconfig.build.json, ship types/
node dist/cli.js --headless --no-daemon                 # exercise the built CLI
```

Node ≥ 22.18 / 24 runs `.ts` directly (type stripping), which `lint` and `test` rely on. Because of that, `tsconfig` sets `erasableSyntaxOnly` — no enums, parameter properties or runtime namespaces — and imports use `.ts` extensions rewritten to `.js` on emit.

Releases: `npm run release` (or `release:minor` / `release:major`) bumps, tags and pushes; `.github/workflows/release.yml` publishes on a `v*` tag via npm trusted publishing (OIDC) or an `NPM_TOKEN` secret.

`main.js` in the root is the untracked original single-file implementation the TypeScript sources were ported from. It is excluded from lint and from the package; treat it as reference only.

## Code conventions (enforced, and the user cares about them)

- 4-space indentation (`.editorconfig`).
- Arrow functions only; no `function` keyword.
- Related functions live in one object with **method shorthand** that calls siblings via `this` (`files.walk`, `cache.merge`, `args.parse`, `daemon.stop`, `machine.cores`). Standalone helpers are `const name = () =>`.
- Short names, ideally one word (`plan`, `text.cut`, `guard.heap.max`). Constants are grouped objects in `src/constants.ts`: `bar`, `paths`, `guard`, `warm`.
- **All types are ambient**: `types/*.d.ts` at the repo root declare global namespaces `Cli`, `Files`, `System`, `Ui`, `Workers` (one file per `src/` folder). Use `Workers.Slot`, `Cli.Options` etc. without importing. Never add `import type` for our own types; never put interfaces next to code. The build copies `types/` into `dist/types/` and prepends `/// <reference>` lines to `dist/index.d.ts` because tsc drops them.
- Every module-level declaration, class/interface member and object-literal property needs a `/** */` comment (`npm run docs` fails otherwise). `//` comments above a declaration do not count.

## Architecture

The run is a parent process orchestrating worker processes over unix sockets. Read these together to understand it:

**`src/cli/run.ts`** is the sequence: parse args → find config → start file discovery (async, with a spinner) → in parallel, `Pool.start()` begins probing warm workers and spawning → await discovery → `pool.assign()` shards files → `pool.begin()` → `await pool.finished` → merge cache → `summary()` returns the exit code (1 on errors/unchecked files/`--max-warnings`, 2 on usage errors).

**`src/workers/pool.ts` (`Pool`)** owns one `Workers.Slot` per thread and is driven by the governor's tick: every sample calls `balance()`, which recycles fat workers, parks/wakes idle ones and spawns cold slots up to `governor.limit`. Files are dealt by contiguous shards (`files.shard`) and rebalanced by work stealing (`steal`). Batches are sized by elapsed time (`adapt`), not count. A crashed worker's in-flight files are re-queued one at a time (`requeue`, `suspects`) so a killer file is identified and eventually reported as unchecked rather than taking the pool down. OOM (detected from the worker's stderr file) bumps the heap, then lowers concurrency.

**`src/system/governor.ts` (`Governor`)** is the safeguard: samples CPU/memory every `guard.interval`, keeps `limit` ≤ `base` (it only ever sheds and recovers, never grows past the sized pool), and enters a *hold* near the physical memory ceiling during which nothing is dispatched. `src/system/sizing.ts` (`plan`) computes the initial numbers once: threads, pool size, per-worker heap, RSS budgets.

**`src/workers/worker.ts`** is the child entry, spawned with `CE_*` env vars (`CE_WORKER=1`, socket path, epoch, heap). It listens first, then lazily imports the project's ESLint (`workers/eslint.ts` resolves from `cwd`). Protocol is newline-delimited JSON (`workers/ipc.ts`): parent → worker `job | batch | release | shutdown`; worker → parent `hello | ready | start | result | idle | fatal | busy` (`Workers.Request` / `Workers.Reply`). A worker must answer one `result` per file dispatched or the run hangs — ignored files are reported with `ignored: true`.

**Warm workers (`src/workers/daemon.ts`)**: workers are detached and outlive the run by default (off under `--headless`/CI/`--no-daemon`). Sockets live in `os.tmpdir()/concurrent-eslint-<hash of cwd>/w-<token>.sock` with a sibling `.stderr` file. `daemon.epoch()` hashes Node version, package version, worker entry mtime, config and lockfile mtimes; a worker whose `hello.epoch` differs is shut down instead of adopted. `--stop-daemon` / `--prune` end them.

**Cache (`src/files/cache.ts`)**: with `--cache` each worker writes its own flat-cache file and `cache.merge` folds them into `.eslintcache-concurrent/cache.json` before and after a run. `cache.open` abstracts over flat-cache 4/5 (`load`) and 6 (`create`), which is what ESLint 9 vs 10 ship.

**UI (`src/ui/`)**: `Reporter` redraws a live block on a TTY (skipped when not a TTY or `--headless`); problems are printed above it through `reporter.print`, which `Pool.print` falls back from when no reporter exists yet. `text` holds ANSI-aware width/padding/truncation; `format` renders one file's messages.

`CE_DEBUG=1` traces governor and pool decisions to stderr; `CE_HEAP_MB` forces the per-worker heap.
