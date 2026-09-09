/**
 * Programmatic entry point. The CLI is a thin wrapper over `run()`.
 *
 * The types are ambient namespaces (Cli, Files, System, Ui, Workers) declared
 * in ../types/*.d.ts. The build copies them next to the compiled output and
 * references them from dist/index.d.ts, so `run()`'s signature resolves for
 * consumers too.
 */

export { run } from "./cli/run.ts"
export { args } from "./cli/options.ts"
export { help } from "./cli/help.ts"
export { plan } from "./system/sizing.ts"
export { machine, ram } from "./system/resources.ts"
export { files } from "./files/discovery.ts"
export { cache } from "./files/cache.ts"
export { daemon } from "./workers/daemon.ts"
export { format } from "./ui/format.ts"
export { palette, text } from "./ui/terminal.ts"
export * from "./constants.ts"
