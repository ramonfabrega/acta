// RealtimeKit REST client. Every response goes through a schema from
// core/schemas.ts; a non-2xx or `success: false` becomes an RtkError that
// carries the HTTP status and the vendor's own message.
import { z } from "zod";
import {
  RtkActiveSessionSchema,
  RtkErrorSchema,
  RtkMeetingSchema,
  RtkParticipantSchema,
  RtkRecordingDetailSchema,
  RtkRecordingSchema,
  RtkWebhookPublicKeySchema,
} from "./core/schemas.ts";

export const RTK_WEBHOOK_KEY_URL = "https://api.realtime.cloudflare.com/.well-known/webhooks.json";
export const RTK_AGENT_WS_URL = "https://api.realtime.cloudflare.com/agent-ws/v1";

export type RtkConfig = { accountId: string; appId: string; token: string };

export class RtkError extends Error {
  constructor(readonly status: number, readonly vendorMessage: string, readonly path: string) {
    super(`realtimekit ${status} on ${path}: ${vendorMessage}`);
    this.name = "RtkError";
  }
}

export function rtkConfig(env: { CF_ACCOUNT_ID: string; RTK_APP_ID: string; RTK_API_TOKEN: string }): RtkConfig {
  return { accountId: env.CF_ACCOUNT_ID, appId: env.RTK_APP_ID, token: env.RTK_API_TOKEN };
}

function base(cfg: RtkConfig): string {
  return `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/realtime/kit/${cfg.appId}`;
}

const Envelope = z.object({ success: z.literal(true), data: z.unknown() }).loose();

/** One REST call; returns the parsed `data`. */
export async function rtkCall<T extends z.ZodType>(
  cfg: RtkConfig,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<T>> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base(cfg)}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new RtkError(res.status, `non-JSON body: ${text.slice(0, 200)}`, path);
  }
  if (!res.ok) throw new RtkError(res.status, vendorMessage(json, text), path);
  const env = Envelope.safeParse(json);
  if (!env.success) throw new RtkError(res.status, vendorMessage(json, text), path);
  const data = schema.safeParse(env.data.data);
  if (!data.success) throw new RtkError(res.status, `unexpected shape: ${data.error.message.slice(0, 300)}`, path);
  return data.data;
}

function vendorMessage(json: unknown, text: string): string {
  const e = RtkErrorSchema.safeParse(json);
  if (e.success) {
    const m = e.data.error?.message ?? e.data.errors?.map((x) => x.message).join("; ");
    if (m) return m;
  }
  return text.slice(0, 300) || "empty body";
}

// --- meetings ----------------------------------------------------------------

export type CreateMeetingInput = { title: string; keywords?: string[] | undefined };

/** Never `record_on_start` (records the agent alone) nor `transcribe_on_end` with `multi` (400). */
export async function createMeeting(cfg: RtkConfig, input: CreateMeetingInput) {
  const transcription: { language: string; keywords?: string[] } = { language: "multi" };
  if (input.keywords && input.keywords.length > 0) transcription.keywords = input.keywords;
  return rtkCall(cfg, "POST", "/meetings", RtkMeetingSchema, {
    title: input.title,
    transcribe_on_end: false,
    summarize_on_end: false,
    session_keep_alive_time_in_secs: 60,
    ai_config: { transcription },
  });
}

export async function listMeetings(cfg: RtkConfig, perPage = 100) {
  return rtkCall(cfg, "GET", `/meetings?per_page=${perPage}&page_no=1`, z.array(RtkMeetingSchema));
}

export type AddParticipantInput = { name: string; preset: "human" | "agent"; userId: string };

export async function addParticipant(cfg: RtkConfig, meetingId: string, p: AddParticipantInput) {
  return rtkCall(cfg, "POST", `/meetings/${encodeURIComponent(meetingId)}/participants`, RtkParticipantSchema, {
    name: p.name,
    preset_name: p.preset,
    custom_participant_id: p.userId,
  });
}

export async function getActiveSession(cfg: RtkConfig, meetingId: string) {
  return rtkCall(cfg, "GET", `/meetings/${encodeURIComponent(meetingId)}/active-session`, RtkActiveSessionSchema);
}

// --- recordings ----------------------------------------------------------------

/** Per-participant audio tracks; `user_ids` omitted = everyone, now and later. Needs a live session. */
/**
 * The track-recording answer is not the composite `{id, status}` shape (seen
 * live 2026-10-23: a 200 without a top-level string `id`). Accept any shape,
 * pull an id out if one is there, and let the `recording.statusUpdate`
 * webhook supply it otherwise.
 */
const TrackStart = z.object({
  id: z.string().optional(),
  recording_id: z.string().optional(),
  status: z.string().optional(),
  recordings: z.array(z.object({ id: z.string().optional(), status: z.string().optional() }).loose()).optional(),
}).loose();
export async function startTrackRecording(cfg: RtkConfig, meetingId: string): Promise<{ id: string | null; status: string | null; raw: unknown }> {
  const raw = await rtkCall(cfg, "POST", "/recordings/track", z.unknown(), { meeting_id: meetingId });
  const d = TrackStart.safeParse(raw);
  if (!d.success) return { id: null, status: null, raw };
  const first = d.data.recordings?.[0];
  return { id: d.data.id ?? d.data.recording_id ?? first?.id ?? null, status: d.data.status ?? first?.status ?? null, raw };
}

export async function getRecording(cfg: RtkConfig, recordingId: string) {
  return rtkCall(cfg, "GET", `/recordings/${encodeURIComponent(recordingId)}`, RtkRecordingDetailSchema);
}

export async function stopRecording(cfg: RtkConfig, recordingId: string) {
  return rtkCall(cfg, "PUT", `/recordings/${encodeURIComponent(recordingId)}`, z.unknown(), { action: "stop" });
}

// --- webhook signing key -------------------------------------------------------

let cachedKey: string | null = null;

/** RealtimeKit's published RSA key; cached per isolate, `refresh` after a failed verify. */
export async function getWebhookPublicKey(refresh = false): Promise<string> {
  if (cachedKey && !refresh) return cachedKey;
  const res = await fetch(RTK_WEBHOOK_KEY_URL);
  if (!res.ok) throw new RtkError(res.status, "webhook key fetch failed", RTK_WEBHOOK_KEY_URL);
  const parsed = RtkWebhookPublicKeySchema.parse(await res.json());
  cachedKey = parsed.data.publicKey;
  return cachedKey;
}
