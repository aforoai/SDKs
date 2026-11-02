/**
 * @file Child-process arguments from the CLI.
 *
 * `--arg <value>` may be repeated; each value reaches the child unchanged, so
 * it can contain commas and spaces. `--args a,b,c` is the older form and
 * splits on commas (an argument can't contain one). Precedence:
 * `--arg` > `--args` > the config file's `args`. Giving both CLI forms uses
 * the `--arg` values and returns a warning to log.
 */

/** commander collector for a repeatable `--arg <value>`. */
export function collectArg(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export interface ChildArgsInput {
  /** Values of the repeatable `--arg` option, in order. */
  arg?: string[];
  /** The comma-separated `--args` value. */
  args?: string;
}

export interface ChildArgs {
  /** Arguments for the child; undefined when the CLI gave none (the config file decides). */
  args: string[] | undefined;
  /** Set when both forms were given. */
  warning?: string;
}

export function resolveChildArgs(input: ChildArgsInput): ChildArgs {
  const repeated = Array.isArray(input.arg) && input.arg.length > 0 ? input.arg.slice() : undefined;
  const split = typeof input.args === 'string' && input.args !== '' ? input.args.split(',') : undefined;
  if (repeated && split) {
    return { args: repeated, warning: 'both --arg and --args were given; using the --arg values and ignoring --args' };
  }
  return { args: repeated ?? split };
}
