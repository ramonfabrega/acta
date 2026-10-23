// Idempotent account setup: the `human` and `agent` presets, the webhook to
// https://<PUBLIC_HOST>/hooks/rtk, and a check that the Worker's secrets
// exist. Prints what it did; never prints a token.
//
//   bun scripts/setup.ts [--dry-run]
//
// RTK_API_TOKEN from the environment, else `passage show tokens/cloudflare/personal/acta/rtk-admin`.
import { $ } from "bun";
import { z } from "zod";
import wrangler from "../wrangler.jsonc";
import { rtkCall, type RtkConfig } from "../src/rtk.ts";

const DRY = process.argv.includes("--dry-run");
const EVENTS = [
  "meeting.started",
  "meeting.ended",
  "meeting.participantJoined",
  "meeting.participantLeft",
  "recording.statusUpdate",
] as const;

const Vars = z.object({
  vars: z.object({ RTK_APP_ID: z.string().min(1), CF_ACCOUNT_ID: z.string().min(1), PUBLIC_HOST: z.string().min(1) }).loose(),
}).loose();

const PresetSummary = z.object({ id: z.string(), name: z.string() }).loose();
const Permissions = z.record(z.string(), z.unknown());
const Preset = z.object({
  id: z.string(),
  name: z.string(),
  config: z.unknown(),
  ui: z.unknown(),
  permissions: Permissions,
}).loose();
const Webhook = z.object({
  id: z.string(),
  name: z.string().optional(),
  url: z.string(),
  events: z.array(z.string()),
  enabled: z.boolean().optional(),
}).loose();

/** The fields each preset must have; nested objects are compared leaf by leaf. */
const WANT: Record<"human" | "agent", Record<string, unknown>> = {
  human: { transcription_enabled: true, can_edit_display_name: true, hidden_participant: false },
  agent: {
    hidden_participant: true,
    transcription_enabled: false,
    media: {
      audio: { can_produce: "NOT_ALLOWED" },
      video: { can_produce: "NOT_ALLOWED" },
      screenshare: { can_produce: "NOT_ALLOWED" },
    },
  },
};

function say(msg: string): void {
  console.log(`${DRY ? "[dry-run] " : ""}${msg}`);
}

async function token(): Promise<string> {
  const fromEnv = process.env["RTK_API_TOKEN"];
  if (fromEnv) return fromEnv.trim();
  const out = await $`passage show tokens/cloudflare/personal/acta/rtk-admin`.quiet().nothrow();
  const t = out.stdout.toString().split("\n")[0]?.trim() ?? "";
  if (out.exitCode !== 0 || !t) throw new Error("RTK_API_TOKEN not set and passage lookup failed");
  return t;
}

/** Leaves of `want` that `have` does not match, as dotted paths. */
function mismatches(have: unknown, want: Record<string, unknown>, path = ""): string[] {
  const out: string[] = [];
  const obj = z.record(z.string(), z.unknown()).catch({}).parse(have);
  for (const [k, v] of Object.entries(want)) {
    const p = path ? `${path}.${k}` : k;
    const parsed = z.record(z.string(), z.unknown()).safeParse(v);
    if (parsed.success && v !== null && typeof v === "object") out.push(...mismatches(obj[k], parsed.data, p));
    else if (obj[k] !== v) out.push(p);
  }
  return out;
}

/** Deep merge of `patch` into `base` (objects only); used to clone a template preset. */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const pv = z.record(z.string(), z.unknown()).safeParse(v);
    const bv = z.record(z.string(), z.unknown()).safeParse(base[k]);
    out[k] = pv.success && bv.success && v !== null && typeof v === "object" ? merge(bv.data, pv.data) : v;
  }
  return out;
}

async function presets(cfg: RtkConfig): Promise<void> {
  const list = await rtkCall(cfg, "GET", "/presets?per_page=100&page_no=1", z.array(PresetSummary));
  for (const name of ["human", "agent"] as const) {
    const want = WANT[name];
    const found = list.find((p) => p.name === name);
    if (found) {
      const p = await rtkCall(cfg, "GET", `/presets/${found.id}`, Preset);
      const bad = mismatches(p.permissions, want);
      if (bad.length === 0) {
        say(`preset ${name}: ok (${p.id})`);
        continue;
      }
      say(`preset ${name}: patching ${bad.join(", ")}`);
      if (!DRY) await rtkCall(cfg, "PATCH", `/presets/${p.id}`, z.unknown(), { permissions: merge(p.permissions, want) });
      continue;
    }
    // Missing: clone a complete preset (the API wants every config/ui/permissions field) and adjust.
    const template = list.find((p) => p.name === "group_call_participant") ?? list.find((p) => p.name !== "agent" && p.name !== "human");
    if (!template) throw new Error(`preset ${name} missing and no preset to clone from; create it in the dashboard`);
    const t = await rtkCall(cfg, "GET", `/presets/${template.id}`, Preset);
    say(`preset ${name}: creating from ${t.name}`);
    if (!DRY) {
      const created = await rtkCall(cfg, "POST", "/presets", PresetSummary, {
        name,
        config: t.config,
        ui: t.ui,
        permissions: merge(t.permissions, want),
      });
      say(`preset ${name}: created (${created.id})`);
    }
  }
}

async function webhook(cfg: RtkConfig, host: string): Promise<void> {
  const url = `https://${host}/hooks/rtk`;
  // An app with no webhooks answers 404 "Webhook not found" instead of [].
  const hooks = await rtkCall(cfg, "GET", "/webhooks", z.array(Webhook)).catch((e: unknown) => {
    if (e instanceof Error && /\b404\b/.test(e.message)) return [];
    throw e;
  });
  const mine = hooks.find((h) => h.url === url) ?? hooks.find((h) => h.name === "acta");
  const body = { name: "acta", url, events: [...EVENTS], enabled: true };
  if (!mine) {
    say(`webhook: registering ${url} for ${EVENTS.length} events`);
    if (!DRY) {
      const h = await rtkCall(cfg, "POST", "/webhooks", Webhook, body);
      say(`webhook: registered (${h.id})`);
    }
    return;
  }
  const same = mine.url === url && mine.enabled !== false
    && EVENTS.every((e) => mine.events.includes(e)) && mine.events.length === EVENTS.length;
  if (same) {
    say(`webhook: ok (${mine.id})`);
    return;
  }
  say(`webhook: updating ${mine.id} -> ${url}, events ${EVENTS.join(",")}`);
  if (!DRY) await rtkCall(cfg, "PATCH", `/webhooks/${mine.id}`, z.unknown(), body);
}

async function secrets(): Promise<void> {
  const out = await $`bunx wrangler secret list --format json`.quiet().nothrow();
  if (out.exitCode !== 0) {
    say("secrets: could not list (is wrangler logged in, is the Worker deployed?)");
    return;
  }
  const parsed = z.array(z.object({ name: z.string() }).loose()).safeParse(JSON.parse(out.stdout.toString() || "[]"));
  const names = new Set(parsed.success ? parsed.data.map((s) => s.name) : []);
  for (const s of ["RTK_API_TOKEN", "ACTA_TOKEN"]) {
    say(`secret ${s}: ${names.has(s) ? "set" : "MISSING (wrangler secret put " + s + ")"}`);
  }
}

async function main(): Promise<void> {
  const w = Vars.parse(wrangler);
  const cfg: RtkConfig = { accountId: w.vars.CF_ACCOUNT_ID, appId: w.vars.RTK_APP_ID, token: await token() };
  await presets(cfg);
  await webhook(cfg, w.vars.PUBLIC_HOST);
  await secrets();
}

main().catch((e: unknown) => {
  console.error(`setup failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
