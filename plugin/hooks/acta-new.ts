#!/usr/bin/env bun
// PostToolUse(Bash) — after `acta new`, make this session the meeting's brain.
//
// The brain is the Claude Code session that minted the meeting (CLAUDE.md). It
// has to arm the harness Monitor on the meeting's events socket, and a hook
// cannot call Monitor: it is a harness tool, session-only. So this hook does
// the two things a hook can do — read the meeting id off the command's output
// and the operator token off passage — and hands the session the exact
// Monitor call as `additionalContext`. Re-arming every 30 minutes, and
// writing the book, stay the session's job: docs/BRAIN.md.
//
// Dependency-free on purpose: the plugin directory has no node_modules.
// Never fails the tool: every exit is 0, and anything that went wrong is a
// line in additionalContext rather than a broken `acta new`.

export const DEFAULT_URL = "https://acta.ramonfabrega.com";
export const PASSAGE_ENTRY = "tokens/cloudflare/personal/acta/acta-token";

/** `acta new`, `bun cli/acta.ts new`, `bun run acta new`, in a pipeline or not. `acta test` mints too, but is its own brain. */
const NEW_RE = /(?:^|[\s;&|(`])(?:bun\s+(?:run\s+)?)?(?:[\w.@~/-]*\/)?acta(?:\.ts)?\s+(?:--?[\w-]+(?:=\S*)?\s+)*new(?=\s|$)/;

export function isActaNew(command: string): boolean {
  return NEW_RE.test(command);
}

/** The meeting id from `acta new`'s answer, whatever format incur rendered it in. */
export function meetingIdFrom(output: string): string | null {
  const fromUrl = output.match(/\/m\/([A-Za-z0-9_-]{8,})\?k=/);
  if (fromUrl?.[1]) return fromUrl[1];
  const toon = output.match(/^\s*id:\s*"?([A-Za-z0-9_-]{8,})"?\s*$/m);
  if (toon?.[1]) return toon[1];
  const json = output.match(/"id":\s*"([A-Za-z0-9_-]{8,})"/);
  return json?.[1] ?? null;
}

/** The events URL the answer carries, else built from ACTA_URL. */
export function eventsUrlFrom(output: string, id: string, env: Record<string, string | undefined> = process.env): string {
  const given = output.match(/^\s*events:\s*"?(wss?:\/\/\S+?)"?\s*$/m)?.[1];
  if (given) return given;
  const base = (env.ACTA_URL ?? DEFAULT_URL).replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/m/${encodeURIComponent(id)}/events`;
}

/** ACTA_TOKEN from the environment, else passage; null when neither answers. */
export function readToken(env: Record<string, string | undefined> = process.env): string | null {
  const fromEnv = env.ACTA_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    // A hook's PATH is whatever launched Claude Code; make sure Homebrew is on it.
    const out = Bun.spawnSync({
      cmd: ["passage", "show", PASSAGE_ENTRY],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, PATH: `${env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` },
    });
    const value = out.stdout.toString().trim();
    return out.exitCode === 0 && value ? value : null;
  } catch {
    return null;
  }
}

/** What the session reads. The token is in it: the URL is the capability Monitor needs. */
export function contextFor(id: string, eventsUrl: string, token: string | null): string {
  const url = token ? `${eventsUrl}?token=${encodeURIComponent(token)}` : `${eventsUrl}?token=<ACTA_TOKEN>`;
  const lines = [
    `acta: meeting ${id} was just minted and this session is its brain. Arm the harness Monitor now, before anyone joins:`,
    "",
    `Monitor({ ws: { url: "${url}" }, description: "acta ${id} events", timeout_ms: 1800000 })`,
    "",
    token
      ? "The token in that URL is the operator bearer (ACTA_TOKEN); do not print it or write it anywhere else."
      : `No token was available: run \`passage show ${PASSAGE_ENTRY}\` (or read ACTA_TOKEN) and put the value in place of <ACTA_TOKEN>.`,
    "Each frame is one notification: hello, started, participant, paragraph, book, ended. Re-arm on every expiry notice (every 30 minutes) until the `ended` frame.",
    `If Monitor is unavailable, \`acta tail ${id}\` under /loop is the fallback. Write the book with \`acta book put ${id} <summary|decisions|actions|notes>\` (read it first with \`acta book show ${id}\`).`,
    "The runbook is docs/BRAIN.md in the acta repo; the acta skill carries the command table.",
  ];
  return lines.join("\n");
}

function textOf(response: unknown): string {
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    return [r.stdout, r.stderr, r.output].filter((v): v is string => typeof v === "string").join("\n");
  }
  return "";
}

function emit(context: string, forUser?: string): never {
  console.log(JSON.stringify({
    ...(forUser ? { systemMessage: forUser } : {}),
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
  }));
  process.exit(0);
}

if (import.meta.main) {
  const payload: unknown = await new Response(Bun.stdin.stream()).json().catch(() => null);
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const input = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
  const command = typeof input.command === "string" ? input.command : "";
  if (p.tool_name !== "Bash" || !isActaNew(command)) process.exit(0);

  const output = textOf(p.tool_response);
  const id = meetingIdFrom(output);
  if (!id) emit("acta: that looked like `acta new`, but no meeting id was found in its output; if a meeting was created, find it with `acta meetings` and arm Monitor per docs/BRAIN.md.");

  const token = readToken();
  emit(contextFor(id, eventsUrlFrom(output, id), token), `acta: meeting ${id} handed to this session as its brain — arm Monitor.`);
}
