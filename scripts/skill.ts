// `bun run plugin:skill`: write plugin/skills/acta/SKILL.md from the command
// table (`acta --llms-full`, the manifest incur prints) behind a fixed
// preamble for the brain. `bun run plugin:skill --check` exits 1 when the
// committed file differs; test/plugin/plugin.test.ts makes the same
// comparison, so the skill cannot drift from the CLI.
import { join } from "node:path";
import { cli } from "../cli/cli.ts";

const root = join(import.meta.dir, "..");
export const SKILL_PATH = join(root, "plugin", "skills", "acta", "SKILL.md");

export const FRONTMATTER = `---
name: acta
description: Own a meeting with the acta CLI — mint a RealtimeKit room (\`acta new\`), be its brain (arm Monitor on the events socket, write the live book with \`acta book put\`), follow its events, export the book and transcript as Markdown, sync recordings to ~/.acta and run the doctor. Use when the user mentions acta, a meeting room, the book, Scribe, or asks to host, transcribe or take notes in a meeting.
---`;

export const PREAMBLE = `# acta

The CLI for acta: a RealtimeKit room with per-speaker transcripts, a Durable
Object (Scribe) that turns them into a live **book**, and recordings copied
into R2. Run it as \`acta\` (after \`bun link\` in the repo) or
\`bun cli/acta.ts\` from the repo root. Every answer is data (TOON by
default; \`--json\`, \`--format yaml|md|jsonl\`); errors carry the server's
own message; exit 0 on success, 1 on any failure.

- \`ACTA_URL\`: the Worker (default \`https://acta.ramonfabrega.com\`).
- \`ACTA_TOKEN\`: the operator bearer; when unset the CLI reads
  \`passage show tokens/cloudflare/personal/acta/acta-token\`. Never print it.

## The brain

The session that runs \`acta new\` is the meeting's brain, on subscription,
never an API key. The acta plugin's hook answers \`acta new\` with the exact
Monitor call; without the hook, build it yourself from the \`events\` URL the
command answers and the token from passage:

\`\`\`
Monitor({ ws: { url: "wss://acta.ramonfabrega.com/m/<id>/events?token=<ACTA_TOKEN>" },
          description: "acta <id> events", timeout_ms: 1800000 })
\`\`\`

Arm it before anyone joins. Each frame is one notification (hello, started,
participant, paragraph, book, ended), twenty to forty an hour. Re-arm on
every expiry notice (every 30 minutes) until the \`ended\` frame; \`acta tail
<id>\` under /loop is the fallback when Monitor is unavailable. Read the book
before writing it (\`acta book show\`), write sections with \`acta book put\`,
and never put meeting data in the repo. The runbook is \`docs/BRAIN.md\`.
The sections below are the command table, generated from the CLI.`;

/** The committed SKILL.md, byte for byte. */
export async function renderSkill(): Promise<string> {
  let manifest = "";
  await cli.serve(["--llms-full"], { stdout: (s) => { manifest += s; }, exit: () => {} });
  // The manifest opens with the CLI's own H1; the preamble carries it instead.
  const body = manifest.replace(/^# acta\n+/, "").trimEnd();
  return `${FRONTMATTER}\n\n${PREAMBLE}\n\n${body}\n`;
}

if (import.meta.main) {
  const want = await renderSkill();
  if (process.argv.includes("--check")) {
    const have = await Bun.file(SKILL_PATH).text().catch(() => "");
    if (have !== want) {
      process.stderr.write(`${SKILL_PATH} is out of date: run \`bun run plugin:skill\`\n`);
      process.exit(1);
    }
    process.stderr.write("skill is current\n");
  } else {
    await Bun.write(SKILL_PATH, want);
    process.stderr.write(`wrote ${SKILL_PATH} (${want.length} chars)\n`);
  }
}
