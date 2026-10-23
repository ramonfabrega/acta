// The Worker: every route in docs/V0.md §"HTTP API". Auth is one of three:
// `bearer` (ACTA_TOKEN, the operator), `cap` (the per-meeting invite in the
// room link, plus a Cloudflare Access JWT when Access is configured), or the
// RealtimeKit RSA signature on /hooks/rtk. Meeting work is RPC on Scribe.
import { Hono, type Context } from "hono";
import { z } from "zod";
import bot from "../test/synth/bot.html" with { type: "text" };
import { accessToken, verifyAccess } from "./access.ts";
import { renderBook } from "./core/book.ts";
import { timingSafeEqual } from "./core/ids.ts";
import {
  EnvSchema,
  JoinBodySchema,
  JoinedBodySchema,
  NewMeetingBodySchema,
  UnknownWebhookSchema,
  type Env,
} from "./core/schemas.ts";
import { verifyRtkSignature } from "./core/webhook.ts";
import { TranscribeBodySchema, WHISPER_MODEL, WhisperOutputSchema, type TranscribeAnswer } from "./core/whisper.ts";
import { renderRoom } from "./room.ts";
import { addParticipant, createMeeting, getWebhookPublicKey, listMeetings, rtkConfig, RtkError } from "./rtk.ts";
import { AGENT_USER_ID, Scribe } from "./scribe.ts";

export { Scribe };

const VERSION = "v0";

const ScribeNamespaceSchema = z.custom<DurableObjectNamespace<Scribe>>((v) => typeof v === "object" && v !== null);

type Vars = { env: Env; identity: string | null };
type C = Context<{ Bindings: Record<string, unknown>; Variables: Vars }>;

const app = new Hono<{ Bindings: Record<string, unknown>; Variables: Vars }>();

function log(ev: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), meeting: fields["meeting"] ?? null, ev, ...fields }));
}

function scribe(c: C, id: string) {
  return ScribeNamespaceSchema.parse(c.var.env.SCRIBE).getByName(id);
}

const MeetingIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

function meetingId(c: C): string | null {
  const r = MeetingIdSchema.safeParse(c.req.param("id"));
  return r.success ? r.data : null;
}

/** The invite is derived, not stored: HMAC(ACTA_TOKEN, meeting id). Stateless to check. */
async function inviteFor(env: Env, id: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ACTA_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`acta-invite:${id}`));
  return Array.from(new Uint8Array(mac).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerOk(env: Env, req: Request): boolean {
  const h = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return Boolean(m?.[1] && timingSafeEqual(m[1].trim(), env.ACTA_TOKEN));
}

/** Events socket token: header, `?token=`, or the second entry of `Sec-WebSocket-Protocol: acta.v1, <token>`. */
function eventsTokenOk(env: Env, req: Request): boolean {
  if (bearerOk(env, req)) return true;
  const q = new URL(req.url).searchParams.get("token");
  if (q && timingSafeEqual(q, env.ACTA_TOKEN)) return true;
  const protos = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim());
  return protos[0] === "acta.v1" && Boolean(protos[1]) && timingSafeEqual(protos[1] ?? "", env.ACTA_TOKEN);
}

type CapResult = { ok: true; email: string | null } | { ok: false; status: 401 | 403; error: string };

async function capCheck(c: C, id: string): Promise<CapResult> {
  const env = c.var.env;
  const k = c.req.query("k") ?? c.req.header("X-Acta-Key") ?? "";
  if (!k) return { ok: false, status: 401, error: "missing invite key" };
  if (!timingSafeEqual(k, await inviteFor(env, id))) return { ok: false, status: 403, error: "bad invite key" };
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return { ok: true, email: null };
  const jwt = accessToken(c.req.raw);
  if (!jwt) return { ok: false, status: 403, error: "missing Access token" };
  const who = await verifyAccess(jwt, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD).catch(() => null);
  if (!who) return { ok: false, status: 403, error: "invalid Access token" };
  return { ok: true, email: who.email };
}

// --- middleware ----------------------------------------------------------------

app.use("*", async (c, next) => {
  const env = EnvSchema.safeParse(c.env);
  if (!env.success) {
    log("env.invalid", { error: env.error.issues.map((i) => i.path.join(".")).join(",") });
    return c.json({ error: "server misconfigured" }, 500);
  }
  c.set("env", env.data);
  c.set("identity", null);
  await next();
});

app.use("/api/*", async (c, next) => {
  if (!bearerOk(c.var.env, c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.onError((err, c) => {
  if (err instanceof RtkError) {
    log("rtk.error", { status: err.status, path: err.path, message: err.vendorMessage });
    return c.json({ error: `realtimekit: ${err.vendorMessage}` }, 502);
  }
  if (err instanceof z.ZodError) return c.json({ error: "bad request", issues: err.issues }, 400);
  log("error", { error: String(err), stack: err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : null });
  return c.json({ error: "internal error" }, 500);
});

async function jsonBody<T extends z.ZodType>(c: C, schema: T): Promise<z.infer<T>> {
  const raw: unknown = await c.req.json().catch(() => null);
  return schema.parse(raw);
}

// --- health -----------------------------------------------------------------------

app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));

// --- operator API (bearer) ------------------------------------------------------------

app.post("/api/meetings", async (c) => {
  const env = c.var.env;
  const body = await jsonBody(c, NewMeetingBodySchema);
  const cfg = rtkConfig(env);
  const m = await createMeeting(cfg, { title: body.title, keywords: body.keywords });
  // The agent joins at creation, before anyone can speak.
  const agent = await addParticipant(cfg, m.id, { name: "acta", preset: "agent", userId: AGENT_USER_ID });
  const invite = await inviteFor(env, m.id);
  const { createdAt } = await scribe(c, m.id).init({
    meetingId: m.id, title: body.title, invite, agentToken: agent.token, keywords: body.keywords ?? [],
  });
  log("meeting.created", { meeting: m.id, title: body.title });
  return c.json({ id: m.id, title: body.title, url: `https://${env.PUBLIC_HOST}/m/${m.id}?k=${invite}`, createdAt }, 201);
});

app.get("/api/meetings", async (c) => {
  const list = await listMeetings(rtkConfig(c.var.env));
  const rows = await Promise.all(list.map(async (m) => {
    const st = await scribe(c, m.id).status().catch(() => null);
    const vendorAt = m.created_at ? Date.parse(m.created_at) : NaN;
    return {
      id: m.id,
      title: st?.title ?? m.title ?? "",
      createdAt: st?.createdAt ?? (Number.isFinite(vendorAt) ? vendorAt : null),
      state: st?.state ?? null,
    };
  }));
  rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return c.json(rows);
});

app.get("/api/meetings/:id", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const st = await scribe(c, id).status();
  return st ? c.json(st) : c.json({ error: "no such meeting" }, 404);
});

app.get("/api/meetings/:id/utterances", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const nd = await scribe(c, id).utterances();
  if (nd === null) return c.json({ error: "no such meeting" }, 404);
  return c.body(nd, 200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
});

app.get("/api/meetings/:id/paragraphs", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const ps = await scribe(c, id).paragraphs();
  return ps ? c.json(ps) : c.json({ error: "no such meeting" }, 404);
});

app.get("/api/meetings/:id/export", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const book = await scribe(c, id).book();
  if (!book) return c.json({ error: "no such meeting" }, 404);
  return c.body(renderBook(book), 200, { "Content-Type": "text/markdown; charset=utf-8" });
});

app.get("/api/meetings/:id/files", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const prefix = `meetings/${id}/`;
  const out: { key: string; size: number; uploaded: string }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page: R2Objects = await c.var.env.MEETINGS.list(cursor ? { prefix, cursor } : { prefix });
    for (const o of page.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return c.json(out);
});

app.get("/api/meetings/:id/files/*", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const marker = `/api/meetings/${id}/files/`;
  const rest = decodeURIComponent(c.req.path.slice(marker.length));
  if (!rest || rest.split("/").some((s) => s === ".." || s === "." || s === "")) return c.json({ error: "bad path" }, 400);
  const obj = await c.var.env.MEETINGS.get(`meetings/${id}/${rest}`);
  if (!obj) return c.json({ error: "not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Content-Length", String(obj.size));
  headers.set("ETag", obj.httpEtag);
  return new Response(obj.body, { headers });
});

const TranscriptNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/);
const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * A batch transcript lands next to the live record (docs/BATCH.md): only
 * `transcripts/` is writable, so the raw sources and the live rows stay
 * what Scribe wrote.
 */
app.put("/api/meetings/:id/files/transcripts/:name", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const name = TranscriptNameSchema.safeParse(c.req.param("name"));
  if (!name.success) return c.json({ error: "bad file name" }, 400);
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > TRANSCRIPT_MAX_BYTES) return c.json({ error: "file too large" }, 413);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > TRANSCRIPT_MAX_BYTES) return c.json({ error: "file too large" }, 413);
  const key = `meetings/${id}/transcripts/${name.data}`;
  const obj = await c.var.env.MEETINGS.put(key, body, { httpMetadata: { contentType: c.req.header("Content-Type") ?? "application/octet-stream" } });
  log("transcript.put", { meeting: id, key, size: obj.size });
  return c.json({ key, size: obj.size });
});

app.post("/api/meetings/:id/end", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const r = await scribe(c, id).end("forced");
  return r.state === null ? c.json({ error: "no such meeting" }, 404) : c.json(r);
});

app.post("/api/meetings/:id/copy", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const r = await scribe(c, id).copy();
  if (!r.ok) return c.json({ error: r.error }, r.status);
  log("copy.requested", { meeting: id, files: r.answer.files, copied: r.answer.copies.filter((x) => x.status === "copied").length });
  return c.json(r.answer);
});

/**
 * The batch pass, one track per call (docs/BATCH.md): read the track from R2,
 * hand it to Whisper on Workers AI as base64, answer the model's words. The
 * CLI (`acta transcribe --engine whisper`) turns them into rows; the same
 * call can later run from Scribe after a copy lands.
 */
app.post("/api/meetings/:id/transcribe", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const body = await jsonBody(c, TranscribeBodySchema);
  const key = `meetings/${id}/recordings/${body.track}`;
  const obj = await c.var.env.MEETINGS.get(key);
  if (!obj) return c.json({ error: `no such track: ${body.track}` }, 404);
  const bytes = await obj.arrayBuffer();
  const audio = Buffer.from(bytes).toString("base64");
  const t = Date.now();
  let raw: unknown;
  try {
    raw = await c.var.env.AI.run(WHISPER_MODEL, {
      audio,
      task: "transcribe",
      ...(body.language ? { language: body.language } : {}),
      ...(body.initialPrompt ? { initial_prompt: body.initialPrompt } : {}),
      ...(body.vadFilter !== undefined ? { vad_filter: body.vadFilter } : {}),
      ...(body.conditionOnPreviousText !== undefined ? { condition_on_previous_text: body.conditionOnPreviousText } : {}),
      ...(body.noSpeechThreshold !== undefined ? { no_speech_threshold: body.noSpeechThreshold } : {}),
      ...(body.hallucinationSilenceThreshold !== undefined ? { hallucination_silence_threshold: body.hallucinationSilenceThreshold } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("transcribe.failed", { meeting: id, track: body.track, bytes: bytes.byteLength, ms: Date.now() - t, error: message });
    return c.json({ error: `workers ai: ${message}` }, 502);
  }
  const ms = Date.now() - t;
  const output = WhisperOutputSchema.safeParse(raw);
  if (!output.success) {
    log("transcribe.bad_shape", { meeting: id, track: body.track, ms, keys: raw && typeof raw === "object" ? Object.keys(raw).join(",") : typeof raw });
    return c.json({ error: `unexpected model output: ${z.prettifyError(output.error)}` }, 502);
  }
  log("transcribe.done", { meeting: id, track: body.track, bytes: bytes.byteLength, ms, segments: output.data.segments.length, words: output.data.word_count ?? null });
  const answer: TranscribeAnswer = { track: body.track, bytes: bytes.byteLength, model: WHISPER_MODEL, ms, output: output.data };
  return c.json(answer);
});

// --- the room (cap) ----------------------------------------------------------------------

app.get("/m/:id", async (c) => {
  const id = meetingId(c);
  if (!id) return c.text("bad meeting id", 400);
  const cap = await capCheck(c, id);
  if (!cap.ok) return c.text(cap.error, cap.status);
  const book = await scribe(c, id).book();
  if (!book) return c.text("no such meeting", 404);
  return c.html(renderRoom({ meetingId: id, title: book.title, accessEmail: cap.email }), 200, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
});

app.post("/m/:id/join", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const cap = await capCheck(c, id);
  if (!cap.ok) return c.json({ error: cap.error }, cap.status);
  const body = await jsonBody(c, JoinBodySchema);
  const r = await scribe(c, id).join({ name: body.name, email: cap.email });
  if (!r.ok) return c.json({ error: r.error }, r.status);
  log("join", { meeting: id, speaker: r.speaker });
  return c.json({ token: r.token, userId: r.userId, speaker: r.speaker });
});

app.post("/m/:id/joined", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  const cap = await capCheck(c, id);
  if (!cap.ok) return c.json({ error: cap.error }, cap.status);
  const body = await jsonBody(c, JoinedBodySchema);
  const ok = await scribe(c, id).mediaConfirmed(body.peerId);
  return ok ? c.body(null, 204) : c.json({ error: "no such meeting" }, 404);
});

app.get("/m/:id/book", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  if (!bearerOk(c.var.env, c.req.raw)) {
    const cap = await capCheck(c, id);
    if (!cap.ok) return c.json({ error: cap.error }, cap.status);
  }
  const book = await scribe(c, id).book();
  return book ? c.json(book) : c.json({ error: "no such meeting" }, 404);
});

app.put("/m/:id/book/:section", async (c) => {
  const id = meetingId(c);
  if (!id) return c.json({ error: "bad meeting id" }, 400);
  if (!bearerOk(c.var.env, c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const md = await c.req.text();
  if (md.length > 256 * 1024) return c.json({ error: "section too large" }, 413);
  const r = await scribe(c, id).putBook(c.req.param("section"), md);
  return r.ok ? c.json({ updatedAt: r.updatedAt }) : c.json({ error: r.error }, r.status);
});

app.get("/m/:id/ws", async (c) => {
  const id = meetingId(c);
  if (!id) return c.text("bad meeting id", 400);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.text("expected websocket", 426);
  const cap = await capCheck(c, id);
  if (!cap.ok) return c.text(cap.error, cap.status);
  return scribe(c, id).fetch(c.req.raw);
});

app.get("/m/:id/events", async (c) => {
  const id = meetingId(c);
  if (!id) return c.text("bad meeting id", 400);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.text("expected websocket", 426);
  if (!eventsTokenOk(c.var.env, c.req.raw)) return c.text("unauthorized", 401);
  return scribe(c, id).fetch(c.req.raw);
});

// --- RealtimeKit webhooks (signature) -----------------------------------------------------

app.post("/hooks/rtk", async (c) => {
  const raw = await c.req.arrayBuffer();
  const sig = c.req.header("rtk-signature") ?? "";
  let ok = await verifyRtkSignature(raw, sig, await getWebhookPublicKey());
  if (!ok && sig) ok = await verifyRtkSignature(raw, sig, await getWebhookPublicKey(true));
  if (!ok) {
    log("hook.bad_signature", { bytes: raw.byteLength });
    return c.json({ error: "bad signature" }, 401);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  const head = UnknownWebhookSchema.safeParse(body);
  const id = head.success ? head.data.meeting?.id : undefined;
  if (!head.success || !id) {
    log("hook.ignored", { event: head.success ? head.data.event : null });
    return c.json({ ok: true });
  }
  const uuid = c.req.header("rtk-uuid") ?? null;
  log("hook.received", { meeting: id, event: head.data.event, uuid });
  c.executionCtx.waitUntil(
    scribe(c, id).hook({ uuid, body }).catch((e: unknown) => log("hook.scribe_failed", { meeting: id, error: String(e) })),
  );
  return c.json({ ok: true });
});

// --- synthetic participant page (the token in the fragment is the auth) ---------------------

const BOT_HTML: string = typeof bot === "string" ? bot : "";

app.get("/synth/bot", (c) => {
  if (!BOT_HTML) return c.text("bot page not bundled", 404);
  return c.html(BOT_HTML, 200, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
});

app.notFound((c) => c.json({ error: "not found" }, 404));

export default app;
