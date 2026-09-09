import { guard, paths, warm } from "../constants.ts"
import { machine } from "../system/resources.ts"
import { palette } from "../ui/terminal.ts"

/** The --help text. */
export const help = (color = process.stdout.isTTY === true): string => {
    const c = palette(color)
    const cores = machine.cores()

    return `
  ${c.bold("concurrent-eslint")} ${c.gray("— multi-process ESLint")}

  ${c.bold("Usage")}
    concurrent-eslint [paths...] [options]

  ${c.bold("Options")}
    -t, --threads <n>      worker ceiling ${c.gray(`(default ${cores * 2} = cores × 2)`)}
        --max-cpu <%>      stay under N% CPU ${c.gray(`(default ${guard.cpu})`)}
        --max-memory <n>   memory budget: a percentage (75, 75%) or an
                           absolute size (8G, 8192M) ${c.gray(`(default ${guard.memory}%)`)}
        --no-safeguard     disable the safeguard ${c.gray("(can take the machine down)")}
        --fix              apply auto-fixable fixes
        --quiet            report errors only, no warnings
        --cache            reuse results for unchanged files ${c.gray(`(kept in ${paths.cache.dir}/)`)}
        --cache-strategy   what marks a file as changed: content ${c.gray("(default)")}
                           or metadata ${c.gray("(mtime + size; a checkout invalidates it)")}
        --max-warnings <n> exit 1 when warnings exceed n
        --changed          only files git reports as changed vs HEAD
        --since <ref>      only files changed since <ref> ${c.gray("(e.g. master)")}
        --headless         no live UI, full-length messages ${c.gray("(for CI)")}
        --no-daemon        one-shot: no workers left behind ${c.gray("(default with --headless or CI)")}
        --daemon           keep them even so
        --stop-daemon      shut the warm workers down
        --prune            shut them down and drop the cache: a truly cold run
        --no-color         disable color
    -h, --help             this help

  ${c.bold("Safeguard")}
    A lint worker costs about ${guard.cost} cores, not one — V8 does GC and
    compilation on background threads — so the pool is sized as
    cores × --max-cpu% ÷ ${guard.cost}, capped by --threads. Right now
    ${c.gray(`${cores} cores → ${Math.max(1, Math.round(cores * guard.cpu / 100 / guard.cost))} workers running, ${Math.max(1, Math.floor(cores * guard.cpu / 100))} slots.`)}
    From there CPU and memory are sampled every ${guard.interval}ms and the pool only
    ever shrinks: surplus workers are parked under sustained load and killed
    under memory pressure, and the rest pick up their files. Each worker also
    gets its own heap cap.
    A worker slot the budget never reached shows as "spare" — its files are
    picked up by the others, nothing is skipped. In the live view ${c.cyan("↙")} counts
    files a worker took off someone else, ${c.gray("↗")} files it handed away, and with
    ${c.gray("--fix")} the ${c.magenta("✎")} counter shows how many lines it rewrote.
    ${c.gray("CE_DEBUG=1 traces every safeguard decision on stderr.")}

  ${c.bold("Daemon")}
    The workers stay alive after the run, and the next run adopts them
    instead of starting fresh ones.
    That skips the config load and, more importantly, keeps the plugins'
    in-process caches warm: import-x's export maps, which are most of what
    the linter does here. Workers retire after ${warm.idle / 60000} idle minutes, and are
    replaced on their own when the config, this tool, Node or the
    dependencies change. That warmth is memory: together the sleeping
    workers may hold up to ${Math.round(warm.share * 100)}% of the ${c.gray("--max-memory")} budget, and one
    that outgrows its share exits instead. ${c.gray("--stop-daemon")} ends them now.
    Under ${c.gray("--headless")} or a CI variable nothing is left behind unless ${c.gray("--daemon")}
    says so; ${c.gray("--no-daemon")} makes any run one-shot.

  ${c.bold("Cache")}
    With ${c.gray("--cache")} every worker writes its own ESLint cache file and after
    the run they are folded into one shared ${c.gray(`${paths.cache.dir}/${paths.cache.file}`)}, so a
    file stays a hit whichever worker picks it up next time. Files are
    matched by content hash, so switching branches only re-lints what
    actually differs. The summary shows the hit count. ${c.gray("--prune")} drops it.

  ${c.bold("Changed files only")}
    ${c.gray("--changed")} takes the working tree against HEAD plus untracked files;
    ${c.gray("--since master")} adds everything that diverged from the merge base, which
    is the set a review would look at. Deleted files are dropped, ignore
    rules still apply, and the whole tree walk is skipped — on a normal
    branch this turns a minute into a couple of seconds.

  ${c.bold("CI")}
    The live view is skipped automatically when stdout is not a TTY;
    ${c.gray("--headless")} forces that off even on a TTY and stops truncating rule
    messages to the terminal width. Exit code is 1 on any error, on an
    unchecked file, or past ${c.gray("--max-warnings")}.

  ${c.bold("Examples")}
    ${c.gray("concurrent-eslint")}
    ${c.gray("concurrent-eslint app/components --fix")}
    ${c.gray("concurrent-eslint --max-cpu 50 --max-memory 60")}
    ${c.gray("concurrent-eslint --changed --fix")}
    ${c.gray("concurrent-eslint --since master --headless --max-warnings 0")}

`
}
