// The command table's types and the one argv parser. Commands are data so
// `acta --help` and `acta --llms` are generated from the same table.

export type ArgSpec = {
  name: string;
  summary: string;
  required?: boolean;
  /** Collects every remaining positional (only the last arg may be variadic). */
  variadic?: boolean;
};

export type FlagType = "string" | "boolean" | "number";

export type FlagSpec = {
  name: string;
  summary: string;
  type: FlagType;
  short?: string;
  default?: string | boolean | number;
  /** Shown in usage for string/number flags, e.g. `file`. */
  placeholder?: string;
};

export type FlagValue = string | boolean | number;

export type Parsed = {
  args: Record<string, string | undefined>;
  /** Values of a variadic arg, in order. */
  rest: string[];
  flags: Record<string, FlagValue | undefined>;
};

export type Command = {
  /** One or two words: `tail`, `book put`. */
  name: string;
  summary: string;
  /** Synopsis line, e.g. `acta tail <id> [--json]`. */
  usage: string;
  args: ArgSpec[];
  flags: FlagSpec[];
  /** Longer notes for --help and --llms; optional. */
  notes?: string;
  run(p: Parsed): Promise<number>;
};

export class UsageError extends Error {
  constructor(message: string, readonly command?: Command) {
    super(message);
    this.name = "UsageError";
  }
}

/** Global flags handled by the entry before any command runs. */
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "help", short: "h", type: "boolean", summary: "Show help for acta or for one command." },
  { name: "llms", type: "boolean", summary: "Print the command table as Markdown (for agents)." },
];

/**
 * Pick the command for argv: two-word names (`book put`) win over one-word
 * names. Returns the command and the argv left after its name.
 */
export function resolve(table: readonly Command[], argv: readonly string[]): { command: Command; rest: string[] } | null {
  // The command name is the leading words of argv, before any flag.
  const a0 = argv[0], a1 = argv[1];
  const word = (s: string | undefined): s is string => s !== undefined && !s.startsWith("-");
  if (word(a0) && word(a1)) {
    const command = table.find((c) => c.name === `${a0} ${a1}`);
    if (command) return { command, rest: argv.slice(2) };
  }
  if (word(a0)) {
    const command = table.find((c) => c.name === a0);
    if (command) return { command, rest: argv.slice(1) };
  }
  return null;
}

/** Commands whose first word is `group` (for `acta book` without a subcommand). */
export function group(table: readonly Command[], word: string): Command[] {
  return table.filter((c) => c.name.split(" ")[0] === word && c.name.includes(" "));
}

/** Parse argv (after the command name) against a command's args and flags. */
export function parse(command: Pick<Command, "args" | "flags"> & { name?: string }, argv: readonly string[]): Parsed {
  const specs = [...command.flags];
  const byName = new Map(specs.map((f) => [f.name, f]));
  const byShort = new Map(specs.filter((f) => f.short).map((f) => [f.short ?? "", f]));
  const flags: Record<string, FlagValue | undefined> = {};
  for (const f of specs) if (f.default !== undefined) flags[f.name] = f.default;
  const positionals: string[] = [];

  const coerce = (f: FlagSpec, raw: string): FlagValue => {
    if (f.type === "number") {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new UsageError(`--${f.name} expects a number, got "${raw}"`);
      return n;
    }
    if (f.type === "boolean") {
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      throw new UsageError(`--${f.name} is a switch; got "${raw}"`);
    }
    return raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (a === "-" || !a.startsWith("-")) { positionals.push(a); continue; }

    let spec: FlagSpec | undefined;
    let inline: string | undefined;
    let negated = false;
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      const key = eq >= 0 ? body.slice(0, eq) : body;
      inline = eq >= 0 ? body.slice(eq + 1) : undefined;
      spec = byName.get(key);
      if (!spec && key.startsWith("no-")) {
        const base = byName.get(key.slice(3));
        if (base?.type === "boolean" && inline === undefined) { spec = base; negated = true; }
      }
      if (!spec) throw new UsageError(`unknown flag --${key}`);
    } else {
      const key = a.slice(1);
      spec = byShort.get(key);
      if (!spec) throw new UsageError(`unknown flag -${key}`);
    }

    if (spec.type === "boolean") {
      flags[spec.name] = negated ? false : inline === undefined ? true : coerce(spec, inline);
      continue;
    }
    const value = inline ?? argv[i + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new UsageError(`--${spec.name} needs a value`);
    }
    if (inline === undefined) i++;
    flags[spec.name] = coerce(spec, value);
  }

  const args: Record<string, string | undefined> = {};
  let rest: string[] = [];
  command.args.forEach((spec, idx) => {
    if (spec.variadic) { rest = positionals.slice(idx); args[spec.name] = rest[0]; return; }
    args[spec.name] = positionals[idx];
  });
  for (const spec of command.args) {
    if (spec.required && args[spec.name] === undefined) throw new UsageError(`missing <${spec.name}>`);
  }
  const takesAll = command.args.some((s) => s.variadic);
  if (!takesAll && positionals.length > command.args.length) {
    throw new UsageError(`unexpected argument "${positionals[command.args.length]}"`);
  }
  return { args, rest, flags };
}

// Typed reads for command bodies; the parser already coerced by spec.

export function str(p: Parsed, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function num(p: Parsed, name: string): number | undefined {
  const v = p.flags[name];
  return typeof v === "number" ? v : undefined;
}

export function bool(p: Parsed, name: string): boolean {
  return p.flags[name] === true;
}

/** Required positional; the parser guarantees presence for `required` args. */
export function arg(p: Parsed, name: string): string {
  const v = p.args[name];
  if (v === undefined) throw new UsageError(`missing <${name}>`);
  return v;
}

/** `--name <placeholder>` / `--[no-]name` as shown in help. */
export function flagLabel(f: FlagSpec): string {
  const short = f.short ? `-${f.short}, ` : "";
  if (f.type === "boolean") return `${short}--${f.name}`;
  return `${short}--${f.name} <${f.placeholder ?? f.type}>`;
}

export function argLabel(a: ArgSpec): string {
  const inner = a.variadic ? `${a.name}...` : a.name;
  return a.required ? `<${inner}>` : `[${inner}]`;
}
