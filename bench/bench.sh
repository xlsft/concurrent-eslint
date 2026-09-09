#!/usr/bin/env bash
# Builds, generates the synthetic corpus next to a node_modules symlink and
# runs every scenario there and in this repository. Results land in
# bench/results/*.json. Keep the machine otherwise idle while it runs.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build >/dev/null
mkdir -p bench/results
corpus="${TMPDIR:-/tmp}/concurrent-eslint-bench"
node bench/generate.mjs "$corpus" "${1:-2000}"
ln -sfn "$PWD/node_modules" "$corpus/node_modules"
node bench/run.mjs "$corpus" 3 large > bench/results/large.json
node bench/run.mjs "$PWD" 3 small > bench/results/small.json
