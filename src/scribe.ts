// Scribe: one Durable Object per meeting, named by the RealtimeKit meeting id.
// It holds the outbound agent socket, stamps finals with its own receipt
// clock, runs the paragraph rule, owns the book, fans sparse frames out to
// the brain (`events`) and the room page (`room`), starts the per-track
// recording, writes the meeting to R2 at the end, and copies the vendor's
// recordings into R2 before their seven-day URLs expire.
//
// One alarm drives everything time-based: the agent ping, its reconnect
// backoff, the paragraph deadline, the leave grace, the no-show cap and the
// pending R2 copies. `arm()` sets it to the earliest of those.
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { appendParagraphToTranscript, emptyBook, renderBook } from "./core/book.ts";
import { slug } from "./core/ids.ts";
import { createParagraphs, wordCount, type Paragraphs } from "./core/paragraphs.ts";
import {
  AgentMessageSchema,
  AgentResultSchema,
  BOOK_SECTIONS,
  BookSectionSchema,
  ConnectionGetDataSchema,
  EnvSchema,
  HookRecordingSchema,
  MeetingStateSchema,
  ParagraphSchema,
  ParticipantSchema,
  StoredUtteranceSchema,
  WebhookSchema,
  UnknownWebhookSchema,
  WritableBookSectionSchema,
  type AgentMessage,
  type Book,
  type BookSection,
  type CopyAnswer,
  type Env,
  type EventFrame,
  type MeetingState,
  type MeetingStatus,
  type Paragraph,
  type Participant,
  type RoomFrame,
  type StoredUtterance,
  type Utterance,
  TrackDownloadUrlSchema,
} from "./core/schemas.ts";
import { RTK_AGENT_WS_URL, addParticipant, getRecording, rtkConfig, startTrackRecording, stopRecording, RtkError } from "./rtk.ts";

const PING_EVERY_MS = 20_000;
const PING_TIMEOUT_MS = 10_000;
const LEAVE_GRACE_MS = 20_000;
/** Nobody showed up: close the agent so it stops billing. A later join reopens. */
const NO_SHOW_MS = 30 * 60_000;
const RECORDING_RETRY_MS = 15_000;
const COPY_MAX_ATTEMPTS = 6;
const AGENT_PRESET = "agent";
const ENGINE = "nova-3";

export const AGENT_USER_ID = "acta-agent";

export type InitInput = { meetingId: string; title: string; invite: string; agentToken: string; keywords: string[] };
export type JoinInput = { name: string; email: string | null };
export type JoinResult =
  | { ok: true; token: string; userId: string; speaker: string }
  | { ok: false; status: 404 | 409 | 502; error: string };
export type HookInput = { uuid: string | null; body: unknown };

// --- rows -------------------------------------------------------------------

const MetaRow = z.object({ key: z.string(), value: z.string() });
const JsonRow = z.object({ json: z.string() });
const CountRow = z.object({ n: z.number() });
const ParticipantRow = z.object({
  peer_id: z.string(),
  participant_id: z.string(),
  user_id: z.string(),
  speaker: z.string(),
  joined_at: z.number(),
  left_at: z.number().nullable(),
  present_at: z.number().nullable(),
});
const BookRow = z.object({ section: BookSectionSchema, markdown: z.string(), updated_at: z.number() });
const CopyRow = z.object({
  key: z.string(),
  kind: z.string(),
  url: z.string().nullable(),
  status: z.string(),
  size: z.number().nullable(),
  at: z.number(),
  attempts: z.number(),
  next_at: z.number().nullable(),
});
const NextAtRow = z.object({ next_at: z.number().nullable() });

type Peer = { userId: string; speaker: string };

/** One recording file to copy: published path under recordings/ and its vendor URL. */
type RecordingFile = { file: string; url: string; kind: string; userId?: string; peerId?: string };

export class Scribe extends DurableObject<Record<string, unknown>> {
  private readonly cfg: Env;
  private readonly sql: SqlStorage;
  private machine: Paragraphs = createParagraphs();
  private agent: WebSocket | null = null;
  private connecting = false;
  private pingAwaitUntil: number | null = null;
  private pingDue: number | null = null;
  private requestSeq = 0;
  private readonly firstPartial = new Map<string, number>();
  private readonly peers = new Map<string, Peer>();
  private readonly earlyPresent = new Set<string>();
  private recordingInFlight = false;
  private armedFor: number | null | undefined = undefined;
  private copying = false;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.cfg = EnvSchema.parse(env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      const st = this.meta("paragraphs");
      if (st) {
        try {
          this.machine.restore(JSON.parse(st));
        } catch (e) {
          this.log("paragraphs.restore_failed", { error: String(e) });
        }
      }
    });
  }

  // --- storage -----------------------------------------------------------------

  private migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS participants (
      peer_id TEXT PRIMARY KEY, participant_id TEXT NOT NULL, user_id TEXT NOT NULL, speaker TEXT NOT NULL,
      joined_at INTEGER NOT NULL, left_at INTEGER, present_at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS utterances (seq INTEGER PRIMARY KEY, t1 INTEGER NOT NULL, json TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS paragraphs (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, t0 INTEGER NOT NULL, json TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS book (section TEXT PRIMARY KEY, markdown TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (uuid TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS copies (
      key TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT, status TEXT NOT NULL, size INTEGER, at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER, error TEXT)`);
  }

  private meta(key: string): string | null {
    const row = this.sql.exec(`SELECT key, value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? MetaRow.parse(row).value : null;
  }

  private metaNum(key: string): number | null {
    const v = this.meta(key);
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private setMeta(key: string, value: string | number | null): void {
    if (value === null) this.sql.exec(`DELETE FROM meta WHERE key = ?`, key);
    else this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, String(value));
  }

  private get meetingId(): string {
    return this.meta("meetingId") ?? "";
  }

  private get state(): MeetingState | null {
    const s = MeetingStateSchema.safeParse(this.meta("state"));
    return s.success ? s.data : null;
  }

  private setState(s: MeetingState): void {
    this.setMeta("state", s);
    this.log("state", { state: s });
  }

  private count(table: "utterances" | "paragraphs"): number {
    return CountRow.parse(this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one()).n;
  }

  private log(ev: string, fields: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ at: new Date().toISOString(), meeting: this.meta("meetingId"), ev, ...fields }));
  }

  // --- RPC ---------------------------------------------------------------------

  /** Idempotent: a second init for the same meeting returns the first createdAt. */
  async init(input: InitInput): Promise<{ createdAt: number }> {
    const existing = this.metaNum("createdAt");
    if (existing !== null) return { createdAt: existing };
    const now = Date.now();
    this.setMeta("meetingId", input.meetingId);
    this.setMeta("title", input.title);
    this.setMeta("invite", input.invite);
    this.setMeta("agentToken", input.agentToken);
    this.setMeta("keywords", JSON.stringify(input.keywords));
    this.setMeta("createdAt", now);
    this.setMeta("noShowAt", now + NO_SHOW_MS);
    for (const s of BOOK_SECTIONS) {
      this.sql.exec(`INSERT OR IGNORE INTO book (section, markdown, updated_at) VALUES (?, '', ?)`, s, now);
    }
    this.setState("idle");
    this.log("init", { title: input.title, keywords: input.keywords.length });
    await this.connectAgent(false);
    await this.arm();
    return { createdAt: now };
  }

  async status(): Promise<MeetingStatus | null> {
    const createdAt = this.metaNum("createdAt");
    const state = this.state;
    if (createdAt === null || state === null) return null;
    const sessionId = this.meta("sessionId");
    const recordingId = this.meta("recordingId");
    const copies = this.sql.exec(`SELECT key, kind, url, status, size, at, attempts, next_at FROM copies ORDER BY at`).toArray()
      .map((r) => CopyRow.parse(r))
      .map((r) => ({ kind: r.kind, key: r.key, status: r.status, size: r.size, at: r.at }));
    return {
      id: this.meetingId,
      title: this.meta("title") ?? "",
      state,
      createdAt,
      session: sessionId
        ? { id: sessionId, startedAt: this.metaNum("sessionStartedAt") ?? createdAt, endedAt: this.metaNum("sessionEndedAt") }
        : null,
      participants: this.participants(),
      counts: { utterances: this.count("utterances"), paragraphs: this.count("paragraphs") },
      recording: recordingId
        ? { id: recordingId, startedAt: this.metaNum("recordingStartedAt") ?? createdAt, status: this.meta("recordingStatus") ?? "unknown" }
        : null,
      copies,
    };
  }

  /** Mints a `human` participant. A join after the end reopens the meeting with a fresh agent. */
  async join(input: JoinInput): Promise<JoinResult> {
    if (this.state === null) return { ok: false, status: 404, error: "no such meeting" };
    const userId = input.email ? `u_${(await sha256Hex(input.email.trim().toLowerCase())).slice(0, 16)}` : `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const name = input.name.trim();
    try {
      const p = await addParticipant(rtkConfig(this.cfg), this.meetingId, { name, preset: "human", userId });
      this.log("join.minted", { userId, speaker: slug(name) });
      if (this.state === "ended") await this.reopen();
      else this.setMeta("leaveAt", null);
      await this.arm();
      return { ok: true, token: p.token, userId, speaker: slug(name) };
    } catch (e) {
      this.log("join.failed", { error: String(e) });
      return { ok: false, status: 502, error: e instanceof RtkError ? e.vendorMessage : String(e) };
    }
  }

  /** The page's `roomJoined`: media is up for this peer. */
  async mediaConfirmed(peerId: string): Promise<boolean> {
    if (this.state === null) return false;
    const now = Date.now();
    const row = this.participant(peerId);
    if (row) this.markPresent(peerId, now);
    else this.earlyPresent.add(peerId);
    this.setMeta("leaveAt", null);
    this.log("media.confirmed", { peerId, known: Boolean(row) });
    await this.maybeStartRecording();
    await this.arm();
    return true;
  }

  async book(): Promise<Book | null> {
    if (this.state === null) return null;
    return this.readBook();
  }

  async putBook(section: string, markdown: string): Promise<{ ok: true; updatedAt: number } | { ok: false; status: 400 | 404; error: string }> {
    if (this.state === null) return { ok: false, status: 404, error: "no such meeting" };
    const s = WritableBookSectionSchema.safeParse(section);
    if (!s.success) return { ok: false, status: 400, error: `section must be one of summary, decisions, actions, notes` };
    const now = Date.now();
    this.writeSection(s.data, markdown, now);
    this.emit({ type: "book", section: s.data, updatedAt: now });
    this.room({ type: "book", ...this.readBook() });
    this.log("book.put", { section: s.data, bytes: markdown.length });
    if (this.state === "ended") await this.putR2("book.md", renderBook(this.readBook()), "text/markdown; charset=utf-8");
    return { ok: true, updatedAt: now };
  }

  /** The meeting's JSONL: one Utterance per line, in t1 order. */
  async utterances(): Promise<string | null> {
    if (this.state === null) return null;
    return this.readUtterances().map((u) => JSON.stringify(stripSeq(u))).join("\n") + (this.count("utterances") ? "\n" : "");
  }

  async paragraphs(): Promise<Paragraph[] | null> {
    if (this.state === null) return null;
    return this.readParagraphs();
  }

  /** A verified RealtimeKit webhook. Deduped by `rtk-uuid`; copies are queued for the alarm. */
  async hook(input: HookInput): Promise<void> {
    if (this.state === null) {
      this.log("hook.unknown_meeting", {});
      return;
    }
    const now = Date.now();
    const uuid = input.uuid ?? `nouuid:${now}:${crypto.randomUUID()}`;
    const kind = UnknownWebhookSchema.safeParse(input.body);
    const cur = this.sql.exec(
      `INSERT OR IGNORE INTO events (uuid, kind, at, json) VALUES (?, ?, ?, ?)`,
      uuid, kind.success ? kind.data.event : "unparsed", now, JSON.stringify(input.body),
    );
    if (cur.rowsWritten === 0) {
      this.log("hook.duplicate", { uuid });
      return;
    }
    const parsed = WebhookSchema.safeParse(input.body);
    if (!parsed.success) {
      this.log("hook.unparsed", { event: kind.success ? kind.data.event : null, error: parsed.error.message.slice(0, 300) });
      return;
    }
    const h = parsed.data;
    switch (h.event) {
      case "meeting.started":
      case "meeting.participantJoined":
      case "meeting.participantLeft":
        this.log("hook", { event: h.event });
        return;
      case "meeting.ended":
        this.log("hook", { event: h.event, reason: h.reason ?? null });
        if (this.state === "live" || this.state === "idle") await this.endMeeting("meeting.ended");
        return;
      case "recording.statusUpdate": {
        const r = h.recording;
        const id = r.id ?? r.recordingId ?? null;
        this.log("hook.recording", { recordingId: id, status: r.status });
        // The start call does not reliably return the id; the first webhook does.
        if (id && !this.meta("recordingId")) {
          this.setMeta("recordingId", id);
          if (!this.metaNum("recordingStartedAt")) this.setMeta("recordingStartedAt", now);
        }
        if (id && id === this.meta("recordingId")) this.setMeta("recordingStatus", r.status);
        if (r.status === "UPLOADED") {
          let files = recordingFiles(r);
          // The webhook may carry no URLs; the recording record always does.
          if (files.length === 0 && id) {
            try {
              const detail = await getRecording(rtkConfig(this.cfg), id);
              files = recordingFiles({ status: detail.status, download_url: detail.download_url, audioDownloadUrl: detail.audio_download_url });
              this.log("hook.recording_detail", { recordingId: id, files: files.length });
            } catch (e) {
              this.log("hook.recording_detail_failed", { recordingId: id, error: e instanceof RtkError ? `${e.status} ${e.vendorMessage}` : String(e) });
            }
          }
          if (files.length === 0) this.log("hook.recording_no_urls", { recordingId: id });
          for (const f of files) this.queueCopy(`recordings/${this.trackFileName(f)}`, f.kind, f.url, now);
          await this.arm();
        } else if (r.status === "ERRORED") {
          this.sql.exec(
            `INSERT INTO copies (key, kind, url, status, size, at, attempts, next_at, error) VALUES (?, 'recording', NULL, 'vendor_errored', NULL, ?, 0, NULL, NULL)
             ON CONFLICT(key) DO UPDATE SET status = 'vendor_errored', at = excluded.at`,
            `${this.prefix()}recordings/${id ?? "unknown"}.errored`, now,
          );
        }
        return;
      }
    }
  }

  /** Forces the end-of-meeting sequence now (tests, operator). */
  async end(reason = "forced"): Promise<{ state: MeetingState | null; utterances: number; paragraphs: number }> {
    if (this.state !== null && this.state !== "ended") await this.endMeeting(reason);
    return { state: this.state, utterances: this.count("utterances"), paragraphs: this.count("paragraphs") };
  }

  /**
   * Operator recovery (`acta copy`): re-reads the recording record from
   * RealtimeKit and copies every file it lists that is not already in R2,
   * now, in this call. The webhook does this on its own; this is for a
   * webhook that arrived without URLs, a copy that failed out, or a URL that
   * expired before the alarm ran. Files already `copied` are left alone.
   */
  async copy(): Promise<{ ok: true; answer: CopyAnswer } | { ok: false; status: 404 | 409; error: string }> {
    if (this.state === null) return { ok: false, status: 404, error: "no such meeting" };
    const recordingId = this.meta("recordingId");
    if (!recordingId) return { ok: false, status: 409, error: "no recording was started for this meeting" };
    const now = Date.now();
    const detail = await getRecording(rtkConfig(this.cfg), recordingId);
    this.setMeta("recordingStatus", detail.status);
    const files = recordingFiles({ id: recordingId, status: detail.status, download_url: detail.download_url, audioDownloadUrl: detail.audio_download_url });
    this.log("copy.requested", { recordingId, status: detail.status, files: files.length });
    for (const f of files) this.queueCopy(`recordings/${this.trackFileName(f)}`, f.kind, f.url, now);
    await this.runCopies(now);
    await this.arm();
    const copies = this.sql.exec(`SELECT key, kind, url, status, size, at, attempts, next_at, error FROM copies WHERE key LIKE ? ORDER BY at`, `${this.prefix()}recordings/%`)
      .toArray().map((r) => CopyRow.extend({ error: z.string().nullable() }).parse(r))
      .map((r) => ({ kind: r.kind, key: r.key, status: r.status, size: r.size, attempts: r.attempts, error: r.error }));
    return { ok: true, answer: { recording: { id: recordingId, status: detail.status }, files: files.length, copies } };
  }

  // --- inbound sockets (hibernation API) -----------------------------------------

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    if (this.state === null) return new Response("no such meeting", { status: 404 });
    const path = new URL(req.url).pathname;
    const tag = path.endsWith("/events") ? "events" : path.endsWith("/ws") ? "room" : null;
    if (!tag) return new Response("not found", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [tag]);
    const headers = new Headers();
    const protos = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (protos.includes("acta.v1")) headers.set("Sec-WebSocket-Protocol", "acta.v1");
    if (tag === "events") {
      const state = this.state;
      send(server, {
        type: "hello",
        meetingId: this.meetingId,
        title: this.meta("title") ?? "",
        since: this.metaNum("createdAt") ?? 0,
        state,
      });
      if (state === "ended") send(server, this.endedFrame());
    } else {
      send(server, { type: "book", ...this.readBook() });
      if (this.state === "ended") send(server, { type: "ended", at: this.metaNum("endedAt") ?? 0 });
    }
    this.log("socket.open", { tag });
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  override async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Both sockets are read-only for their clients in v0; "ping" is auto-answered.
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _clean: boolean): Promise<void> {
    this.log("socket.close", { tag: this.ctx.getTags(ws)[0] ?? null, code });
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      // already closed
    }
  }

  private emit(frame: EventFrame): void {
    for (const ws of this.ctx.getWebSockets("events")) send(ws, frame);
  }

  private room(frame: RoomFrame): void {
    for (const ws of this.ctx.getWebSockets("room")) send(ws, frame);
  }

  // --- the agent socket ------------------------------------------------------------

  private async connectAgent(resume: boolean): Promise<void> {
    if (this.agent || this.connecting) return;
    const token = this.meta("agentToken");
    if (!token) return;
    this.connecting = true;
    const url = new URL(RTK_AGENT_WS_URL);
    url.searchParams.set("subscriptions", "transcript,participant");
    const connId = this.meta("connectionId");
    if (resume && connId) url.searchParams.set("connection_id", connId);
    try {
      const res = await fetch(url.toString(), {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${token}`, "Sec-WebSocket-Protocol": "realtimekit.v1" },
      });
      const ws = res.webSocket;
      if (!ws) {
        const body = await res.text().catch(() => "");
        this.log("agent.connect_failed", { status: res.status, body: body.slice(0, 200), resume });
        this.scheduleReconnect(res.status === 401 || res.status === 403 ? null : "backoff");
        return;
      }
      ws.accept();
      this.agent = ws;
      this.pingAwaitUntil = null;
      this.pingDue = Date.now() + PING_EVERY_MS;
      this.setMeta("reconnectAt", null);
      this.setMeta("reconnectAttempts", 0);
      ws.addEventListener("message", (ev) => {
        if (ws !== this.agent) return;
        const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
        void this.onAgentFrame(data).catch((e) => this.log("agent.frame_error", { error: String(e) }));
      });
      ws.addEventListener("close", (ev) => {
        void this.onAgentClose(ws, ev.code, ev.reason).catch((e) => this.log("agent.close_error", { error: String(e) }));
      });
      ws.addEventListener("error", () => this.log("agent.error", {}));
      this.request("connection.get");
      this.log("agent.open", { resume: Boolean(resume && connId) });
    } catch (e) {
      this.log("agent.connect_failed", { error: String(e), resume });
      this.scheduleReconnect("backoff");
    } finally {
      this.connecting = false;
    }
  }

  private request(name: "connection.get" | "connection.ping"): void {
    if (!this.agent) return;
    const id = `${name}:${++this.requestSeq}`;
    try {
      this.agent.send(JSON.stringify({ category: "request", request_id: id, name, data: {} }));
    } catch (e) {
      this.log("agent.send_failed", { name, error: String(e) });
    }
  }

  /** `mode`: "backoff" resumes with growing delay; "fresh" drops the connection id; null stops. */
  private scheduleReconnect(mode: "backoff" | "fresh" | null): void {
    if (mode === null) {
      this.setMeta("reconnectAt", null);
      this.setMeta("agentStopped", "1");
      return;
    }
    if (mode === "fresh") this.setMeta("connectionId", null);
    const attempts = this.metaNum("reconnectAttempts") ?? 0;
    // First retry inside the 5 s resume grace; then 1, 2, 4 … 30 s.
    const delay = attempts === 0 ? 250 : Math.min(30_000, 500 * 2 ** attempts);
    this.setMeta("reconnectAttempts", attempts + 1);
    this.setMeta("reconnectAt", Date.now() + delay);
  }

  private async onAgentClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (ws !== this.agent) return; // we already let go of it
    this.agent = null;
    this.pingAwaitUntil = null;
    this.pingDue = null;
    this.log("agent.close", { code, reason });
    const state = this.state;
    if (state === "ended" || state === "ending") return;
    if (code === 1000) {
      // session_ended: a new session needs a new connection; this meeting's session is over.
      this.setMeta("connectionId", null);
      await this.endMeeting(reason || "session_ended");
      return;
    }
    if (code === 4403) {
      this.log("agent.rejected", { reason });
      this.scheduleReconnect(null);
    } else if (code === 4409) {
      this.scheduleReconnect(null);
    } else if (code === 1013 && reason.includes("queue_overflow")) {
      this.scheduleReconnect("fresh");
    } else {
      this.scheduleReconnect("backoff");
    }
    await this.arm();
  }

  private closeAgent(code: number, reason: string): void {
    const ws = this.agent;
    this.agent = null;
    this.pingAwaitUntil = null;
    this.pingDue = null;
    if (!ws) return;
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  private async onAgentFrame(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.log("agent.non_json", { bytes: raw.length });
      return;
    }
    const now = Date.now();
    const cat = z.object({ category: z.string() }).loose().safeParse(json);
    if (cat.success && cat.data.category === "result") {
      const r = AgentResultSchema.safeParse(json);
      if (!r.success) return;
      if (r.data.error) {
        this.log("agent.result_error", { request: r.data.request_id, error: r.data.error.message });
        return;
      }
      if (r.data.request_id?.startsWith("connection.ping")) this.pingAwaitUntil = null;
      if (r.data.request_id?.startsWith("connection.get")) {
        const d = ConnectionGetDataSchema.safeParse(r.data.data);
        if (d.success) this.setMeta("connectionId", d.data.connection.id);
      }
      return;
    }
    const m = AgentMessageSchema.safeParse(json);
    if (!m.success) {
      const name = z.object({ name: z.string() }).loose().safeParse(json);
      this.log("agent.unparsed", { name: name.success ? name.data.name : null });
      return;
    }
    await this.onAgentMessage(m.data, now);
  }

  private async onAgentMessage(m: AgentMessage, now: number): Promise<void> {
    switch (m.name) {
      case "session.started": {
        const s = m.data.session;
        const prev = this.meta("sessionId");
        if (prev === s.id) {
          this.log("agent.gap", { sessionId: s.id }); // a resumed connection marks lost events this way
          return;
        }
        this.setMeta("sessionId", s.id);
        this.setMeta("sessionStartedAt", now);
        this.setMeta("sessionEndedAt", null);
        if (this.metaNum("startedAt") === null) this.setMeta("startedAt", now);
        if (this.state === "idle") this.setState("live");
        this.emit({ type: "started", sessionId: s.id, at: now });
        this.log("session.started", { sessionId: s.id });
        void this.maybeStartRecording();
        return;
      }
      case "session.ended": {
        this.setMeta("sessionEndedAt", now);
        this.log("session.ended", { reason: m.data.reason ?? null });
        if (this.state === "live" || this.state === "idle") await this.endMeeting(m.data.reason ?? "session_ended");
        return;
      }
      case "participant.join": {
        const p = m.data.participant;
        if (p.preset_name === AGENT_PRESET || p.custom_participant_id === AGENT_USER_ID) return;
        const known = this.participant(p.peer_id);
        const peer = this.upsertParticipant(p.peer_id, p.participant_id ?? p.peer_id, p.custom_participant_id, p.display_name, now);
        this.setMeta("leaveAt", null);
        if (this.earlyPresent.delete(p.peer_id)) this.markPresent(p.peer_id, now);
        if (!known) {
          this.emit({ type: "participant", event: "join", speaker: peer.speaker, userId: peer.userId, at: now });
          this.log("participant.join", { peerId: p.peer_id, speaker: peer.speaker });
        } else {
          this.log("participant.rejoin", { peerId: p.peer_id }); // a failed first attempt, same peer
        }
        void this.maybeStartRecording();
        await this.arm();
        return;
      }
      case "participant.leave": {
        const p = m.data.participant;
        if (p.preset_name === AGENT_PRESET || p.custom_participant_id === AGENT_USER_ID) return;
        const row = this.participant(p.peer_id);
        if (!row) return;
        if (row.left_at === null) {
          this.sql.exec(`UPDATE participants SET left_at = ? WHERE peer_id = ?`, now, p.peer_id);
          this.emit({ type: "participant", event: "leave", speaker: row.speaker, userId: row.user_id, at: now });
          this.log("participant.leave", { peerId: p.peer_id, speaker: row.speaker });
        }
        this.firstPartial.delete(p.peer_id);
        const inRoom = CountRow.parse(this.sql.exec(`SELECT COUNT(*) AS n FROM participants WHERE left_at IS NULL`).one()).n;
        const everPresent = CountRow.parse(this.sql.exec(`SELECT COUNT(*) AS n FROM participants WHERE present_at IS NOT NULL`).one()).n;
        if (inRoom === 0 && everPresent > 0 && (this.state === "live" || this.state === "idle")) {
          this.setMeta("leaveAt", now + LEAVE_GRACE_MS);
          this.log("leave.grace", { endsAt: now + LEAVE_GRACE_MS });
        }
        await this.arm();
        return;
      }
      case "participant.kick_all":
        this.log("participant.kick_all", {});
        return;
      case "transcript.received":
        await this.onTranscript(m.data, now);
        return;
    }
  }

  private async onTranscript(d: Extract<AgentMessage, { name: "transcript.received" }>["data"], now: number): Promise<void> {
    const sp = d.speaker;
    const peer = this.peerFor(sp.peer_id, sp.participant_id, sp.custom_participant_id, sp.display_name, now);
    if (!d.is_final) {
      if (!this.firstPartial.has(sp.peer_id)) this.firstPartial.set(sp.peer_id, now);
      this.machine.partial(peer.userId, now);
      await this.arm();
      return;
    }
    const first = this.firstPartial.get(sp.peer_id);
    this.firstPartial.delete(sp.peer_id);
    const text = d.text.trim();
    // Never await before the insert: a second final would land first and
    // break the JSONL's t1 order (seen live 2026-10-23). The start call
    // guards its own concurrency and logs its own failures.
    if (text && this.participant(sp.peer_id)?.present_at == null) {
      this.markPresent(sp.peer_id, now);
      void this.maybeStartRecording();
    }
    const t1 = now;
    const t0 = Math.min(t1, first ?? t1 - Math.max(800, 60 * wordCount(text)));
    const seq = this.count("utterances");
    const u: StoredUtterance = {
      seq, t0, t1, speaker: peer.speaker, userId: peer.userId, peerId: sp.peer_id,
      text, lang: null, final: true, engine: ENGINE, conf: d.confidence ?? null,
    };
    this.sql.exec(`INSERT INTO utterances (seq, t1, json) VALUES (?, ?, ?)`, seq, t1, JSON.stringify(u));
    const closed = this.machine.push(u);
    this.saveParagraphState();
    for (const p of closed) this.storeParagraph(p);
    await this.arm();
  }

  // --- participants ------------------------------------------------------------------

  private participant(peerId: string): z.infer<typeof ParticipantRow> | null {
    const row = this.sql.exec(`SELECT * FROM participants WHERE peer_id = ?`, peerId).toArray()[0];
    return row ? ParticipantRow.parse(row) : null;
  }

  private participants(): Participant[] {
    return this.sql.exec(`SELECT * FROM participants ORDER BY joined_at`).toArray().map((r) => {
      const p = ParticipantRow.parse(r);
      return ParticipantSchema.parse({
        peerId: p.peer_id, participantId: p.participant_id, userId: p.user_id, speaker: p.speaker,
        joinedAt: p.joined_at, leftAt: p.left_at, presentAt: p.present_at,
      });
    });
  }

  private peerFor(peerId: string, participantId: string | null, userId: string | null, name: string | null, now: number): Peer {
    const cached = this.peers.get(peerId);
    if (cached) return cached;
    const row = this.participant(peerId);
    if (row) {
      const p = { userId: row.user_id, speaker: row.speaker };
      this.peers.set(peerId, p);
      return p;
    }
    // A transcript before (or without) its join: register the peer from the speaker fields.
    return this.upsertParticipant(peerId, participantId ?? peerId, userId, name, now);
  }

  /** Idempotent by peer_id. The speaker slug is fixed at first sight and unique per userId. */
  private upsertParticipant(peerId: string, participantId: string, customId: string | null, name: string | null, now: number): Peer {
    const userId = customId || participantId || peerId;
    const row = this.participant(peerId);
    if (row) {
      this.sql.exec(`UPDATE participants SET left_at = NULL WHERE peer_id = ?`, peerId);
      const p = { userId: row.user_id, speaker: row.speaker };
      this.peers.set(peerId, p);
      return p;
    }
    const same = this.sql.exec(`SELECT speaker FROM participants WHERE user_id = ? LIMIT 1`, userId).toArray()[0];
    let speaker = same ? z.object({ speaker: z.string() }).parse(same).speaker : slug(name ?? "guest");
    if (!same) {
      const base = speaker;
      for (let n = 2; this.sql.exec(`SELECT 1 FROM participants WHERE speaker = ? AND user_id != ?`, speaker, userId).toArray().length > 0; n++) {
        speaker = `${base}-${n}`;
      }
    }
    this.sql.exec(
      `INSERT INTO participants (peer_id, participant_id, user_id, speaker, joined_at, left_at, present_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      peerId, participantId, userId, speaker, now,
    );
    const p = { userId, speaker };
    this.peers.set(peerId, p);
    return p;
  }

  private markPresent(peerId: string, now: number): void {
    this.sql.exec(`UPDATE participants SET present_at = COALESCE(present_at, ?) WHERE peer_id = ?`, now, peerId);
    this.setMeta("noShowAt", null);
  }

  // --- recording ----------------------------------------------------------------------

  /** First present human of a session starts the per-track recording, once. */
  private async maybeStartRecording(): Promise<void> {
    const sessionId = this.meta("sessionId");
    if (!sessionId || this.state !== "live" || this.recordingInFlight) return;
    if (this.meta("recordingSession") === sessionId) return;
    const present = CountRow.parse(this.sql.exec(`SELECT COUNT(*) AS n FROM participants WHERE present_at IS NOT NULL AND left_at IS NULL`).one()).n;
    if (present === 0 && this.earlyPresent.size === 0) return;
    const last = this.metaNum("recordingAttemptAt");
    const now = Date.now();
    if (last !== null && now - last < RECORDING_RETRY_MS) return;
    this.recordingInFlight = true;
    this.setMeta("recordingAttemptAt", now);
    try {
      const r = await startTrackRecording(rtkConfig(this.cfg), this.meetingId);
      if (r.id) this.setMeta("recordingId", r.id);
      this.setMeta("recordingSession", sessionId);
      this.setMeta("recordingStartedAt", Date.now());
      this.setMeta("recordingStatus", r.status ?? "RECORDING");
      this.log("recording.started", { recordingId: r.id, sessionId, shape: r.id ? undefined : JSON.stringify(r.raw).slice(0, 300) });
    } catch (e) {
      // 409: a track recording already runs for this session; the webhook names it.
      if (e instanceof RtkError && e.status === 409) {
        this.setMeta("recordingSession", sessionId);
        this.log("recording.already_running", { sessionId });
      } else {
        this.log("recording.start_failed", { error: e instanceof RtkError ? `${e.status} ${e.vendorMessage}` : String(e) });
      }
    } finally {
      this.recordingInFlight = false;
    }
  }

  // --- paragraphs and the book -------------------------------------------------------

  private saveParagraphState(): void {
    this.setMeta("paragraphs", JSON.stringify(this.machine.state()));
  }

  private storeParagraph(p: Paragraph): void {
    this.sql.exec(`INSERT OR IGNORE INTO paragraphs (id, t0, json) VALUES (?, ?, ?)`, p.id, p.t0, JSON.stringify(p));
    const start = this.metaNum("startedAt") ?? this.metaNum("createdAt") ?? p.t0;
    const current = this.readBook().sections.transcript ?? "";
    this.writeSection("transcript", appendParagraphToTranscript(current, p, start), Date.now());
    this.emit({ type: "paragraph", paragraph: p });
    this.room({ type: "paragraph", paragraph: p });
    this.room({ type: "book", ...this.readBook() });
    this.log("paragraph", { id: p.id, speaker: p.speaker, words: wordCount(p.text), asides: p.asides.length });
  }

  private readBook(): Book {
    const book = emptyBook(this.meta("title") ?? "");
    for (const r of this.sql.exec(`SELECT section, markdown, updated_at FROM book`).toArray()) {
      const row = BookRow.parse(r);
      book.sections[row.section] = row.markdown;
    }
    return book;
  }

  private writeSection(section: BookSection, markdown: string, now: number): void {
    this.sql.exec(
      `INSERT INTO book (section, markdown, updated_at) VALUES (?, ?, ?) ON CONFLICT(section) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
      section, markdown, now,
    );
  }

  private readUtterances(): StoredUtterance[] {
    return this.sql.exec(`SELECT json FROM utterances ORDER BY seq`).toArray()
      .map((r) => StoredUtteranceSchema.parse(JSON.parse(JsonRow.parse(r).json)));
  }

  private readParagraphs(): Paragraph[] {
    return this.sql.exec(`SELECT json FROM paragraphs ORDER BY n`).toArray()
      .map((r) => ParagraphSchema.parse(JSON.parse(JsonRow.parse(r).json)));
  }

  // --- end of meeting ------------------------------------------------------------------

  private endedFrame(): EventFrame {
    return {
      type: "ended",
      at: this.metaNum("endedAt") ?? 0,
      reason: this.meta("endReason") ?? "",
      utterances: this.count("utterances"),
      paragraphs: this.count("paragraphs"),
    };
  }

  private async endMeeting(reason: string): Promise<void> {
    const state = this.state;
    if (state === "ending" || state === "ended" || state === null) return;
    this.setState("ending");
    const now = Date.now();
    this.setMeta("leaveAt", null);
    this.setMeta("reconnectAt", null);
    this.setMeta("noShowAt", null);
    this.closeAgent(1000, "meeting ended");
    // The track recording also stops with the session; stopping it here makes the upload start now.
    const recId = this.meta("recordingId");
    if (recId && this.meta("recordingStatus") === "RECORDING") {
      try {
        await stopRecording(rtkConfig(this.cfg), recId);
        this.setMeta("recordingStatus", "STOPPED");
      } catch (e) {
        this.log("recording.stop_failed", { error: String(e) });
      }
    }
    for (const p of this.machine.flush(Number.MAX_SAFE_INTEGER)) this.storeParagraph(p);
    this.saveParagraphState();
    this.firstPartial.clear();
    this.setMeta("endedAt", now);
    this.setMeta("endReason", reason);
    try {
      await this.writeMeetingToR2();
    } catch (e) {
      this.log("r2.write_failed", { error: String(e) });
    }
    this.setState("ended");
    this.emit(this.endedFrame());
    this.room({ type: "ended", at: now });
    this.log("ended", { reason, utterances: this.count("utterances"), paragraphs: this.count("paragraphs") });
    await this.arm();
  }

  /** A join after the end: same meeting id, a new session, a fresh agent connection. */
  private async reopen(): Promise<void> {
    this.log("reopen", {});
    this.setMeta("connectionId", null);
    this.setMeta("endedAt", null);
    this.setMeta("endReason", null);
    this.setMeta("reconnectAttempts", 0);
    this.setMeta("agentStopped", null);
    this.setMeta("noShowAt", Date.now() + NO_SHOW_MS);
    this.setState("idle");
    await this.connectAgent(false);
  }

  private prefix(): string {
    return `meetings/${this.meetingId}/`;
  }

  private async putR2(name: string, body: string, contentType: string): Promise<void> {
    await this.cfg.MEETINGS.put(`${this.prefix()}${name}`, body, { httpMetadata: { contentType } });
  }

  private async writeMeetingToR2(): Promise<void> {
    const utterances = (await this.utterances()) ?? "";
    const paragraphs = this.readParagraphs();
    const meta = {
      id: this.meetingId,
      title: this.meta("title") ?? "",
      createdAt: this.metaNum("createdAt"),
      startedAt: this.metaNum("startedAt"),
      endedAt: this.metaNum("endedAt"),
      reason: this.meta("endReason"),
      sessionId: this.meta("sessionId"),
      recordingId: this.meta("recordingId"),
      keywords: z.array(z.string()).catch([]).parse(JSON.parse(this.meta("keywords") ?? "[]")),
      participants: this.participants(),
      counts: { utterances: this.count("utterances"), paragraphs: paragraphs.length },
      engine: ENGINE,
    };
    await Promise.all([
      this.putR2("utterances.jsonl", utterances, "application/x-ndjson"),
      this.putR2("paragraphs.json", JSON.stringify(paragraphs, null, 2), "application/json"),
      this.putR2("book.md", renderBook(this.readBook()), "text/markdown; charset=utf-8"),
      this.putR2("meta.json", JSON.stringify(meta, null, 2), "application/json"),
    ]);
    this.log("r2.written", { utterances: meta.counts.utterances, paragraphs: paragraphs.length });
  }

  // --- R2 copies of vendor files ------------------------------------------------------------

  /** `<speaker>-<peer8>.webm` for a track we can attribute; the vendor name otherwise. */
  private trackFileName(f: RecordingFile): string {
    if (!f.userId || !f.peerId) return f.file;
    const row = this.sql.exec(`SELECT speaker FROM participants WHERE user_id = ? ORDER BY joined_at LIMIT 1`, f.userId).toArray()[0];
    const speaker = z.object({ speaker: z.string() }).safeParse(row);
    const who = speaker.success ? speaker.data.speaker : f.userId;
    return safeName(`${who}-${f.peerId.slice(0, 8)}.webm`);
  }

  private queueCopy(rel: string, kind: string, url: string, now: number): void {
    const key = `${this.prefix()}${rel}`;
    this.sql.exec(
      `INSERT INTO copies (key, kind, url, status, size, at, attempts, next_at, error) VALUES (?, ?, ?, 'pending', NULL, ?, 0, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET url = excluded.url, status = CASE WHEN copies.status = 'copied' THEN 'copied' ELSE 'pending' END,
         next_at = CASE WHEN copies.status = 'copied' THEN NULL ELSE excluded.next_at END, at = excluded.at,
         attempts = CASE WHEN copies.status = 'copied' THEN copies.attempts ELSE 0 END,
         error = CASE WHEN copies.status = 'copied' THEN copies.error ELSE NULL END`,
      key, kind, url, now, now,
    );
    this.log("copy.queued", { key, kind });
  }

  private async runCopies(now: number): Promise<void> {
    if (this.copying) return;
    this.copying = true;
    try {
      const due = this.sql.exec(`SELECT key, kind, url, status, size, at, attempts, next_at FROM copies WHERE status = 'pending' AND next_at <= ?`, now)
        .toArray().map((r) => CopyRow.parse(r));
      for (const c of due) {
        if (!c.url) continue;
        try {
          const res = await fetch(c.url);
          if (!res.ok || !res.body) throw new Error(`vendor ${res.status}`);
          const type = res.headers.get("Content-Type") ?? "application/octet-stream";
          // R2 needs a known length to stream; buffer when the vendor sends chunked.
          const len = res.headers.get("Content-Length");
          const body = len ? res.body : await res.arrayBuffer();
          const obj = await this.cfg.MEETINGS.put(c.key, body, { httpMetadata: { contentType: type } });
          this.sql.exec(`UPDATE copies SET status = 'copied', size = ?, at = ?, next_at = NULL, error = NULL, attempts = attempts + 1 WHERE key = ?`, obj.size, Date.now(), c.key);
          this.log("copy.done", { key: c.key, size: obj.size });
        } catch (e) {
          const attempts = c.attempts + 1;
          const failed = attempts >= COPY_MAX_ATTEMPTS;
          this.sql.exec(
            `UPDATE copies SET status = ?, attempts = ?, next_at = ?, error = ? WHERE key = ?`,
            failed ? "failed" : "pending", attempts, failed ? null : Date.now() + 60_000 * 2 ** attempts, String(e).slice(0, 300), c.key,
          );
          this.log("copy.failed", { key: c.key, attempts, error: String(e) });
        }
      }
    } finally {
      this.copying = false;
    }
  }

  // --- the one alarm -----------------------------------------------------------------------

  private async arm(): Promise<void> {
    const live = this.state === "idle" || this.state === "live";
    const candidates: number[] = [];
    if (live) {
      if (this.agent) {
        if (this.pingDue !== null) candidates.push(this.pingDue);
        if (this.pingAwaitUntil !== null) candidates.push(this.pingAwaitUntil);
      } else {
        // No socket in memory (eviction, failed connect): the alarm is how it comes back.
        if (!this.agentStopped()) candidates.push(this.metaNum("reconnectAt") ?? Date.now() + 1000);
      }
      for (const k of ["leaveAt", "noShowAt"]) {
        const v = this.metaNum(k);
        if (v !== null) candidates.push(v);
      }
    }
    const pd = this.machine.nextDeadline();
    if (pd !== null) candidates.push(pd);
    const copy = this.sql.exec(`SELECT MIN(next_at) AS next_at FROM copies WHERE status = 'pending'`).toArray()[0];
    const nextCopy = copy ? NextAtRow.parse(copy).next_at : null;
    if (nextCopy !== null) candidates.push(nextCopy);
    const at = candidates.length ? Math.max(Date.now() + 50, Math.min(...candidates)) : null;
    if (at === this.armedFor) return; // partials re-arm 2–4 times a second; skip the no-op write
    this.armedFor = at;
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  /** 4403/4409 stop the agent for good; the alarm must not keep retrying. */
  private agentStopped(): boolean {
    return this.meta("agentStopped") === "1";
  }

  override async alarm(): Promise<void> {
    this.armedFor = undefined;
    const now = Date.now();
    const state = this.state;
    if (state === "idle" || state === "live") {
      const noShow = this.metaNum("noShowAt");
      const leave = this.metaNum("leaveAt");
      if (noShow !== null && now >= noShow) {
        await this.endMeeting("no_show");
      } else if (leave !== null && now >= leave) {
        await this.endMeeting("last_leave");
      } else if (this.agent) {
        if (this.pingAwaitUntil !== null && now >= this.pingAwaitUntil) {
          this.log("agent.ping_timeout", {});
          this.closeAgent(4000, "ping timeout");
          this.scheduleReconnect("backoff");
          await this.connectAgent(true);
        } else if (this.pingDue !== null && now >= this.pingDue) {
          this.request("connection.ping");
          this.pingAwaitUntil = now + PING_TIMEOUT_MS;
          this.pingDue = now + PING_EVERY_MS;
        }
        await this.maybeStartRecording();
      } else {
        const at = this.metaNum("reconnectAt");
        if (!this.agentStopped() && (at === null || now >= at)) await this.connectAgent(true);
      }
    }
    const closed = this.machine.flush(now);
    if (closed.length) {
      this.saveParagraphState();
      for (const p of closed) this.storeParagraph(p);
    }
    await this.arm();
    await this.runCopies(now);
    await this.arm();
  }
}

// --- helpers -------------------------------------------------------------------------------

function send(ws: WebSocket, frame: EventFrame | RoomFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // a closing socket; its close handler cleans up
  }
}

function stripSeq(u: StoredUtterance): Utterance {
  const { seq: _seq, ...rest } = u;
  return rest;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Last path segment, made safe as an R2 key part. */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 180) || "file";
}

function basename(url: string): string | null {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : null;
  } catch {
    return null;
  }
}

/** The agent's own track is silence; never copy it. */
const AGENT_CUSTOM_ID = "acta-agent";

/**
 * Both shapes: composite (`downloadUrl` / `audioDownloadUrl` strings) and
 * track (`{links: [...]}` or a bare array of layers, each a map of file →
 * `{download_url, peer_id, custom_participant_id}`), from the webhook
 * (camelCase) or the REST record (snake_case).
 */
export function recordingFiles(r: Pick<z.infer<typeof HookRecordingSchema>, "id" | "recordingId" | "status" | "downloadUrl" | "download_url" | "audioDownloadUrl" | "outputFileName">): RecordingFile[] {
  const out: RecordingFile[] = [];
  const seen = new Set<string>();
  const id = r.id ?? r.recordingId ?? "recording";
  const add = (f: RecordingFile, layer?: string) => {
    let name = safeName(f.file);
    if (seen.has(name) && layer) name = `${safeName(layer)}_${name}`;
    if (seen.has(name)) name = `${out.length}_${name}`;
    seen.add(name);
    out.push({ ...f, file: name });
  };
  const dl = r.downloadUrl ?? r.download_url ?? null;
  if (typeof dl === "string" && dl) {
    add({ file: r.outputFileName || basename(dl) || `${id}.mp4`, url: dl, kind: "recording" });
  } else if (dl) {
    const parsed = TrackDownloadUrlSchema.safeParse(dl);
    const layers = parsed.success ? (Array.isArray(parsed.data) ? parsed.data : parsed.data.links) : [];
    for (const layer of layers) {
      for (const [file, v] of Object.entries(layer.download_urls ?? {})) {
        if (v.custom_participant_id === AGENT_CUSTOM_ID) continue;
        const f: RecordingFile = { file, url: v.download_url, kind: "track" };
        if (v.custom_participant_id) f.userId = v.custom_participant_id;
        if (v.peer_id) f.peerId = v.peer_id;
        add(f, layer.layer_name);
      }
    }
  }
  if (r.audioDownloadUrl) add({ file: basename(r.audioDownloadUrl) || `${id}.audio`, url: r.audioDownloadUrl, kind: "audio" });
  return out;
}
