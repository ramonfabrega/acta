// Typed client for the acta Worker (docs/V0.md §HTTP API). Every answer is
// parsed with zod; a non-2xx answer becomes an ApiError carrying the
// server's own message. The bearer never reaches stdout or stderr.
import { z } from "zod";
import {
  BookSchema,
  CopyAnswerSchema,
  EventFrameSchema,
  MeetingStatusSchema,
  ParagraphSchema,
  StoredUtteranceSchema,
  type Book,
  type EventFrame,
  type MeetingStatus,
  type Paragraph,
  type WritableBookSectionSchema,
} from "../src/core/schemas.ts";

export const DEFAULT_URL = "https://acta.ramonfabrega.com";
export const PASSAGE_ENTRY = "tokens/cloudflare/personal/acta/acta-token";

// --- response shapes not owned by src/core --------------------------------

/** Epoch ms or an ISO string: the CLI only displays it. */
const Instant = z.union([z.number(), z.string()]);

export const CreatedMeetingSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  url: z.string().url(),
  createdAt: Instant,
}).loose();
export type CreatedMeeting = z.infer<typeof CreatedMeetingSchema>;

export const MeetingListItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  createdAt: Instant.nullable().optional(),
  /** Scribe state when known; null when Scribe has never seen the meeting. */
  state: z.string().nullable().optional(),
}).loose();
export const MeetingListSchema = z.array(MeetingListItemSchema);
export type MeetingListItem = z.infer<typeof MeetingListItemSchema>;

export const FileEntrySchema = z.object({
  key: z.string().min(1),
  size: z.number().int().nonnegative(),
  uploaded: Instant.nullable().optional(),
}).loose();
export const FileListSchema = z.array(FileEntrySchema);
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const JoinAnswerSchema = z.object({ token: z.string().min(1), userId: z.string().min(1), speaker: z.string().min(1) }).loose();
export type JoinAnswer = z.infer<typeof JoinAnswerSchema>;

export const PutBookAnswerSchema = z.object({ updatedAt: z.number() }).loose();
export const HealthSchema = z.object({ ok: z.boolean(), version: z.string().optional() }).loose();

/** The JSONL row; `seq` is present when Scribe includes it. */
export const UtteranceRowSchema = StoredUtteranceSchema.partial({ seq: true });
export type UtteranceRow = z.infer<typeof UtteranceRowSchema>;

/** Whatever the Worker answers on an error; we only want a message. */
const ErrorBodySchema = z.union([
  z.object({ error: z.string() }).loose().transform((b) => b.error),
  z.object({ error: z.object({ message: z.string() }).loose() }).loose().transform((b) => b.error.message),
  z.object({ message: z.string() }).loose().transform((b) => b.message),
]);

export class ApiError extends Error {
  constructor(readonly method: string, readonly path: string, readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
  override toString(): string {
    return `${this.method} ${this.path} → ${this.status}: ${this.message}`;
  }
}

// --- config ----------------------------------------------------------------

export function baseUrl(): string {
  return (process.env.ACTA_URL ?? DEFAULT_URL).replace(/\/+$/, "");
}

let cachedToken: string | undefined;

/** ACTA_TOKEN from env, else `passage show …`; cached for the process. */
export function token(): string {
  if (cachedToken) return cachedToken;
  const env = process.env.ACTA_TOKEN?.trim();
  if (env) return (cachedToken = env);
  let value = "";
  let exitCode: number | null = null;
  try {
    const out = Bun.spawnSync({ cmd: ["passage", "show", PASSAGE_ENTRY], stdout: "pipe", stderr: "pipe" });
    value = out.stdout.toString().trim();
    exitCode = out.exitCode;
  } catch { /* passage not installed */ }
  if (exitCode !== 0 || !value) {
    throw new Error(`no ACTA_TOKEN: set it in the environment or store it in passage at ${PASSAGE_ENTRY}`);
  }
  return (cachedToken = value);
}

// --- HTTP ------------------------------------------------------------------

type Auth = { kind: "bearer" } | { kind: "cap"; key: string } | { kind: "none" };

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = ErrorBodySchema.safeParse(JSON.parse(text));
    if (body.success) return body.data;
  } catch { /* not JSON */ }
  return text.trim().slice(0, 500) || res.statusText || "request failed";
}

export async function request(method: string, path: string, opts: { auth?: Auth; body?: BodyInit; contentType?: string } = {}): Promise<Response> {
  const auth = opts.auth ?? { kind: "bearer" };
  const headers = new Headers();
  if (auth.kind === "bearer") headers.set("authorization", `Bearer ${token()}`);
  if (auth.kind === "cap") headers.set("x-acta-key", auth.key);
  if (opts.contentType) headers.set("content-type", opts.contentType);
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { method, headers, body: opts.body ?? null });
  } catch (e) {
    throw new ApiError(method, path, 0, `network: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new ApiError(method, path, res.status, await errorMessage(res));
  return res;
}

async function json<T>(schema: z.ZodType<T>, method: string, path: string, opts?: Parameters<typeof request>[2]): Promise<T> {
  const res = await request(method, path, opts);
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new ApiError(method, path, res.status, `expected JSON, got: ${text.slice(0, 200)}`); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(method, path, res.status, `unexpected answer shape: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const enc = encodeURIComponent;

// --- API -------------------------------------------------------------------

export const api = {
  health: () => json(HealthSchema, "GET", "/healthz", { auth: { kind: "none" } }),

  createMeeting: (title: string, keywords?: string[]) =>
    json(CreatedMeetingSchema, "POST", "/api/meetings", {
      body: JSON.stringify(keywords?.length ? { title, keywords } : { title }),
      contentType: "application/json",
    }),

  meetings: () => json(MeetingListSchema, "GET", "/api/meetings"),

  status: (id: string): Promise<MeetingStatus> => json(MeetingStatusSchema, "GET", `/api/meetings/${enc(id)}`),

  async utterances(id: string): Promise<UtteranceRow[]> {
    const path = `/api/meetings/${enc(id)}/utterances`;
    const text = await (await request("GET", path)).text();
    return text.split("\n").filter((l) => l.trim()).map((line, i) => {
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { throw new ApiError("GET", path, 200, `line ${i + 1} is not JSON`); }
      const row = UtteranceRowSchema.safeParse(raw);
      if (!row.success) throw new ApiError("GET", path, 200, `line ${i + 1}: ${z.prettifyError(row.error)}`);
      return row.data;
    });
  },

  paragraphs: (id: string): Promise<Paragraph[]> => json(z.array(ParagraphSchema), "GET", `/api/meetings/${enc(id)}/paragraphs`),

  exportMarkdown: async (id: string) => (await request("GET", `/api/meetings/${enc(id)}/export`)).text(),

  files: (id: string): Promise<FileEntry[]> => json(FileListSchema, "GET", `/api/meetings/${enc(id)}/files`),

  /** `rel` is the key below `meetings/<id>/`; the body streams. */
  file: (id: string, rel: string) =>
    request("GET", `/api/meetings/${enc(id)}/files/${rel.split("/").map(enc).join("/")}`),

  end: async (id: string) => { await request("POST", `/api/meetings/${enc(id)}/end`); },

  /** Vendor → R2, now: Scribe re-reads the recording record and copies what is missing. */
  copy: (id: string) => json(CopyAnswerSchema, "POST", `/api/meetings/${enc(id)}/copy`),

  book: (id: string): Promise<Book> => json(BookSchema, "GET", `/m/${enc(id)}/book`),

  putBook: (id: string, section: z.infer<typeof WritableBookSectionSchema>, markdown: string) =>
    json(PutBookAnswerSchema, "PUT", `/m/${enc(id)}/book/${enc(section)}`, { body: markdown, contentType: "text/markdown; charset=utf-8" }),

  /** Mint a `human` participant with the meeting's capability key. */
  join: (id: string, key: string, name: string): Promise<JoinAnswer> =>
    json(JoinAnswerSchema, "POST", `/m/${enc(id)}/join`, {
      auth: { kind: "cap", key },
      body: JSON.stringify({ name }),
      contentType: "application/json",
    }),
};

/** Key below `meetings/<id>/` for a listed file, whichever form the list uses. */
export function relativeKey(id: string, key: string): string {
  const prefix = `meetings/${id}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** The capability `k` from a room URL. */
export function capabilityOf(roomUrl: string): string {
  const k = new URL(roomUrl).searchParams.get("k");
  if (!k) throw new Error("room URL carries no ?k= capability");
  return k;
}

// --- events socket ------------------------------------------------------------

export type EventsHandlers = {
  frame(f: EventFrame): void;
  /** A frame that did not parse; the raw text, for stderr. */
  invalid?(raw: string, why: string): void;
  close?(code: number, reason: string): void;
  open?(): void;
};

export type EventsSocket = { close(): void; readonly closed: Promise<{ code: number; reason: string }> };

/**
 * Bun's WebSocket takes `{headers}`; the global type here comes from
 * workers-types, which only knows protocols. Same runtime object.
 */
type BunWebSocketCtor = new (url: string, opts: { headers: Record<string, string> }) => WebSocket;
const BunWebSocket = WebSocket as unknown as BunWebSocketCtor;

/** `wss://…/m/<id>/events`, without a token: the brain appends `?token=` when it arms Monitor. */
export function eventsUrl(id: string): string {
  return `${baseUrl().replace(/^http/, "ws")}/m/${enc(id)}/events`;
}

/** Open `/m/:id/events` with the bearer in the Authorization header (Bun only). */
export function events(id: string, h: EventsHandlers): EventsSocket {
  const ws = new BunWebSocket(eventsUrl(id), { headers: { authorization: `Bearer ${token()}` } });
  let resolveClosed: (v: { code: number; reason: string }) => void = () => {};
  const closed = new Promise<{ code: number; reason: string }>((r) => { resolveClosed = r; });
  ws.addEventListener("open", () => h.open?.());
  ws.addEventListener("message", (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data instanceof ArrayBuffer ? ev.data : new Uint8Array());
    let body: unknown;
    try { body = JSON.parse(raw); } catch { h.invalid?.(raw, "not JSON"); return; }
    const f = EventFrameSchema.safeParse(body);
    if (f.success) h.frame(f.data);
    else h.invalid?.(raw, z.prettifyError(f.error));
  });
  ws.addEventListener("close", (ev) => { h.close?.(ev.code, ev.reason); resolveClosed({ code: ev.code, reason: ev.reason }); });
  ws.addEventListener("error", () => { /* close follows */ });
  return { close: () => ws.close(1000, "done"), closed };
}
