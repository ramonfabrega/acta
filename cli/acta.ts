#!/usr/bin/env bun
// acta CLI entry: resolve the command from argv, parse, run, map errors to
// exit codes (0 ok, 1 failure, 2 usage). Errors go to stderr with the
// server's own message.
import { group, parse, resolve, UsageError } from "./args.ts";
import { ApiError } from "./client.ts";
import { COMMANDS } from "./commands/index.ts";
import { renderCommandHelp, renderHelp, renderLlms } from "./llms.ts";

export async function main(argv: string[]): Promise<number> {
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  if (argv.includes("--llms")) { process.stdout.write(renderLlms(COMMANDS)); return 0; }
  if (argv.length === 0 || (wantsHelp && (argv[0] ?? "-").startsWith("-"))) {
    process.stdout.write(renderHelp(COMMANDS));
    return argv.length === 0 ? 2 : 0;
  }

  const hit = resolve(COMMANDS, argv);
  if (!hit) {
    const sub = group(COMMANDS, argv[0] ?? "");
    if (sub.length) {
      process.stderr.write(`acta ${argv[0]}: pick one of: ${sub.map((c) => c.name).join(", ")}\n`);
      return 2;
    }
    process.stderr.write(`acta: unknown command "${argv[0]}"\n\n${renderHelp(COMMANDS)}`);
    return 2;
  }
  const { command, rest } = hit;
  if (wantsHelp) { process.stdout.write(renderCommandHelp(command)); return 0; }

  try {
    return await command.run(parse(command, rest));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`acta ${command.name}: ${e.message}\nusage: ${command.usage}\n`);
      return 2;
    }
    if (e instanceof ApiError) {
      process.stderr.write(`acta ${command.name}: ${e.toString()}\n`);
      return 1;
    }
    process.stderr.write(`acta ${command.name}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
