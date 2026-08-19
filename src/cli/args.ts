export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags that take NO value. They have to be named, because a parser that guesses
 * gets this wrong in the one way that matters:
 *
 *   codeontic gate --repo-root /repo --strict-anchors /repo
 *
 * Reading "the next token that is not `--…`" as the value swallows `/repo` into
 * `--strict-anchors`. The result is two silent failures at once: the positional
 * list is empty, so the target directory falls back to the current working
 * directory (a different tree than the caller named), and `--strict-anchors`
 * fails its `=== true` test, so the strict mode the caller asked for quietly
 * does not happen. Both directions loosen the check, and the run still exits 0.
 *
 * Keeping this list next to the parser rather than per-command is deliberate:
 * one place to add to when a boolean flag is introduced, and the parse stays a
 * pure function of argv.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "strict-anchors",
  "strict-adapter",
  "no-cache",
  "drift-json",
  "model-only",
  "validate",
]);

/** Minimal `--flag value` / `--flag` (boolean) parser — no dependency for 3 subcommands. */
export function parseFlags(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}
