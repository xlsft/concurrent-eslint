# concurrent-eslint

Multi-process ESLint runner. It globs every file your `eslint.config.*`
applies to, spreads the files across worker processes and shows live
progress in braille. Errors are printed the moment a worker finds them.

- **Safeguard.** CPU and memory are sampled twice a second; the pool is
  sized to a budget (75% of both by default) and only ever shrinks under
  load: surplus workers are parked, fat ones recycled, and under real
  memory pressure the pool holds until the machine has room again.
- **Warm workers.** Workers outlive the run. The next run adopts them,
  skipping the config load and keeping every plugin's in-process cache
  (import-x export maps above all) warm.
- **Shared cache.** With `--cache` every worker writes its own ESLint cache
  and the parent folds them into one file, so a file stays a hit whichever
  worker picks it up next time.
- **Changed files only.** `--changed` and `--since <ref>` ask git instead of
  walking the tree.

## Install

```bash
npm install --save-dev concurrent-eslint eslint
```

ESLint is a peer dependency: the project's own copy is what lints, resolved
from the project you run in. ESLint 9 and 10 are supported, Node 20.19+.

## Usage

```bash
npx concurrent-eslint                      # whole project
npx concurrent-eslint src --fix            # a subtree, with fixes
npx concurrent-eslint --changed --fix      # what git says changed
npx concurrent-eslint --since main --headless --max-warnings 0   # CI
```

```
-t, --threads <n>      worker ceiling (default cores × 2)
    --max-cpu <%>      stay under N% CPU (default 75)
    --max-memory <n>   memory budget: a percentage (75, 75%) or a size (8G, 8192M)
    --no-safeguard     disable the safeguard
    --fix              apply auto-fixable fixes
    --quiet            report errors only
    --cache            reuse results for unchanged files
    --cache-strategy   content (default) or metadata
    --max-warnings <n> exit 1 when warnings exceed n
    --changed          only files git reports as changed vs HEAD
    --since <ref>      only files changed since <ref>
    --headless         no live UI, full-length messages (for CI)
    --no-daemon        one-shot: no workers left behind (default under --headless or CI)
    --daemon           keep them even so
    --stop-daemon      shut the warm workers down
    --prune            shut them down and drop the cache
    --no-color         disable color
-h, --help             the full help, with how the safeguard is sized
```

Exit code is 1 on any error, on a file that could not be checked, or past
`--max-warnings`; 2 on a usage error. `CE_DEBUG=1` traces every safeguard
decision on stderr.

### Programmatic use

```ts
import { run, args } from "concurrent-eslint"

const code = await run(["--headless", "--max-warnings", "0"], { cwd: process.cwd() })
const options: Cli.Options = args.parse(["--fix", "src"])
```

The types come as ambient namespaces (`Cli`, `Files`, `System`, `Ui`,
`Workers`) referenced from the package's declarations, so they are visible
without an import.

## Benchmarks

Measured on an 8-core Linux box with 24 GB RAM, Node 24, ESLint 10.10.
Wall-clock is the median of 3 runs; "warm" means the second run, with the
cache primed or the workers left by the first run. Every row reports the
same problem counts. Reproduce with `npm run bench` (see `bench/`).

**Synthetic corpus**: 2,000 TypeScript files, 415k lines, `@eslint/js` +
`typescript-eslint` recommended (no type-aware rules).

| | wall | CPU (user+sys) |
|---|---:|---:|
| `eslint .` | 56 s | 77 s |
| `eslint . --cache` (warm) | 3.0 s | 3.9 s |
| `eslint . --concurrency=auto` | 24.2 s | 116 s |
| `eslint . --concurrency=auto --cache` (warm) | 2.9 s | 4.0 s |
| `concurrent-eslint --no-daemon` | 23.5 s | 111 s |
| `concurrent-eslint --no-daemon --cache` (warm) | 4.3 s | 16 s |
| `concurrent-eslint` (warm workers) | **17.7 s** | ¹ |
| `concurrent-eslint --cache` (warm workers + cache) | **2.1 s** | ¹ |

**Small project**: this repository, 34 files.

| | wall |
|---:|---:|
| `eslint .` / `--concurrency=auto` | 2.8 s |
| `eslint . --cache` (warm) | 1.5 s |
| `concurrent-eslint --no-daemon` | 2.9 s |
| `concurrent-eslint` (warm workers) | **0.66 s** |
| `concurrent-eslint --cache` (warm workers + cache) | **0.25 s** |

**Real application**: a Nuxt/Vue code base, 1,859 files, `vue-eslint-parser`,
`eslint-plugin-vue`, `eslint-plugin-import-x` with the TypeScript resolver.
Measured on the same machine while an IDE and a dev server held 12 GB, so
the safeguard was parking workers against the 75% memory budget for most of
each run.

| | wall |
|---|---:|
| `eslint .` | 148 s |
| `eslint . --concurrency=auto` | 60 s |
| `concurrent-eslint --no-daemon` | 68–75 s |
| `concurrent-eslint` (warm workers) | **41–61 s** |

## Development

```bash
npm install
npm run typecheck     # tsc, no emit
npm test              # node:test, runs the sources directly
npm run lint          # lints this repository with this tool, from the sources
npm run docs          # JSDoc coverage; every symbol must be documented
npm run build         # tsc → dist/
npm run check         # typecheck + lint + docs + test
```

JSDoc coverage is 100% and enforced: `scripts/jsdoc.mjs` walks `src/`,
`types/` and `scripts/` with the TypeScript compiler API and fails on any
module-level declaration, class or interface member, or object-literal
property without a `/** */` comment.

The sources are ESM TypeScript in `src/`, split by concern:

```
types/              ambient declarations, one namespace per src folder
src/
  cli.ts            bin entry
  index.ts          programmatic API
  constants.ts      every tunable, grouped (bar, paths, guard, warm)
  cli/              args, help, the run itself, the summary
  files/            files (tree walk, git, sharding) and the shared cache
  system/           machine (cores, memory), the Governor, the plan
  ui/               palette and text helpers, the Reporter, format
  workers/          worker process, ipc, daemon, the Pool
scripts/build.mjs   tsc, then ships types/ next to dist/ and references them
```

Node 22.18+ / 24 runs the `.ts` sources directly (type stripping), which is
what `npm test` and `npm run lint` rely on; the published package is the
compiled `dist/`.

## Publishing

Releases are cut by tag. Bump, tag and push in one go:

```bash
npm run release          # patch
npm run release:minor
npm run release:major
```

`.github/workflows/release.yml` then runs the checks, builds, verifies that
the tag matches `package.json`, publishes to npm with provenance and creates
a GitHub release with generated notes.

Authentication is npm trusted publishing (OIDC): on npmjs.com open the
package → *Settings* → *Trusted publishers* and add this repository with
the workflow file name `release.yml`. No token needs to be stored. If you
would rather use a token, add an `NPM_TOKEN` secret with an automation
token and the same workflow picks it up.

The first publish has to happen once before trusted publishing can be
configured for the package:

```bash
npm login
npm publish --access public
```

## License

MIT
