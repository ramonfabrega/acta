// Every boundary has a schema here: the Worker env, RealtimeKit's agent
// events and webhooks, our own rows (Utterance, Paragraph, Book) and the
// frames on the events socket. Vendor payloads are `.loose()` so an added
// field never throws; our own shapes are strict.
import { z } from "zod";

// --- env -----------------------------------------------------------------

export const EnvSchema = z.object({
  RTK_APP_ID: z.string().min(1),
  CF_ACCOUNT_ID: z.string().min(1),
  PUBLIC_HOST: z.string().min(1),
  CF_ACCESS_TEAM_DOMAIN: z.string().default(""),
  CF_ACCESS_AUD: z.string().default(""),
  RTK_API_TOKEN: z.string().min(1),
  ACTA_TOKEN: z.string().min(16),
  SCRIBE: z.custom<DurableObjectNamespace>((v) => typeof v === "object" && v !== null),
  MEETINGS: z.custom<R2Bucket>((v) => typeof v === "object" && v !== null),
  AI: z.custom<Ai>((v) => typeof v === "object" && v !== null),
});
export type Env = z.infer<typeof EnvSchema>;

// --- our rows ------------------------------------------------------------

export const UtteranceSchema = z.object({
  t0: z.number().int(),
  t1: z.number().int(),
  speaker: z.string().min(1),
  userId: z.string().min(1),
  peerId: z.string().min(1),
  text: z.string(),
  lang: z.string().nullable(),
  final: z.literal(true),
  engine: z.string().min(1),
  conf: z.number().nullable(),
});
export type Utterance = z.infer<typeof UtteranceSchema>;
/** An utterance as stored: `seq` is its position in the meeting's JSONL. */
export const StoredUtteranceSchema = UtteranceSchema.extend({ seq: z.number().int().nonnegative() });
export type StoredUtterance = z.infer<typeof StoredUtteranceSchema>;

export const AsideSchema = z.object({ speaker: z.string(), text: z.string(), t0: z.number().int() });
export type Aside = z.infer<typeof AsideSchema>;

export const ParagraphSchema = z.object({
  id: z.string().min(1),
  t0: z.number().int(),
  t1: z.number().int(),
  speaker: z.string().min(1),
  userId: z.string().min(1),
  text: z.string(),
  utterances: z.array(z.number().int().nonnegative()),
  asides: z.array(AsideSchema),
});
export type Paragraph = z.infer<typeof ParagraphSchema>;

export const BOOK_SECTIONS = ["summary", "decisions", "actions", "notes", "transcript"] as const;
export const BookSectionSchema = z.enum(BOOK_SECTIONS);
export type BookSection = z.infer<typeof BookSectionSchema>;
export const WritableBookSectionSchema = z.enum(["summary", "decisions", "actions", "notes"]);
export const BookSchema = z.object({
  title: z.string(),
  sections: z.record(BookSectionSchema, z.string()),
});
export type Book = z.infer<typeof BookSchema>;

export const ParticipantSchema = z.object({
  peerId: z.string(),
  participantId: z.string(),
  userId: z.string(),
  speaker: z.string(),
  joinedAt: z.number().int(),
  leftAt: z.number().int().nullable(),
  presentAt: z.number().int().nullable(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const MeetingStateSchema = z.enum(["idle", "live", "ending", "ended"]);
export type MeetingState = z.infer<typeof MeetingStateSchema>;

// --- events socket frames (sparse by design) -----------------------------

export const EventFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), meetingId: z.string(), title: z.string(), since: z.number().int(), state: MeetingStateSchema }),
  z.object({ type: z.literal("started"), sessionId: z.string(), at: z.number().int() }),
  z.object({ type: z.literal("participant"), event: z.enum(["join", "leave"]), speaker: z.string(), userId: z.string(), at: z.number().int() }),
  z.object({ type: z.literal("paragraph"), paragraph: ParagraphSchema }),
  z.object({ type: z.literal("book"), section: BookSectionSchema, updatedAt: z.number().int() }),
  z.object({ type: z.literal("ended"), at: z.number().int(), reason: z.string(), utterances: z.number().int(), paragraphs: z.number().int() }),
]);
export type EventFrame = z.infer<typeof EventFrameSchema>;

/** Frames the room page receives on /m/:id/ws. */
export const RoomFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("book"), title: z.string(), sections: z.record(BookSectionSchema, z.string()) }),
  z.object({ type: z.literal("paragraph"), paragraph: ParagraphSchema }),
  z.object({ type: z.literal("ended"), at: z.number().int() }),
]);
export type RoomFrame = z.infer<typeof RoomFrameSchema>;

// --- RealtimeKit agent socket --------------------------------------------

const AgentSpeaker = z.object({
  peer_id: z.string(),
  participant_id: z.string(),
  custom_participant_id: z.string().nullable(),
  display_name: z.string().nullable(),
}).loose();

const AgentParticipant = z.object({
  peer_id: z.string(),
  participant_id: z.string().nullable(),
  meeting_id: z.string().nullable(),
  custom_participant_id: z.string().nullable(),
  display_name: z.string().nullable(),
  preset_name: z.string().nullable().optional(),
  waitlisted: z.boolean().optional(),
}).loose();

export const AgentMessageSchema = z.discriminatedUnion("name", [
  z.object({ category: z.literal("message"), name: z.literal("session.started"),
    data: z.object({ session: z.object({ id: z.string(), meeting_id: z.string(), started_at: z.string(), ended_at: z.string().nullable() }).loose() }).loose() }),
  z.object({ category: z.literal("message"), name: z.literal("session.ended"),
    data: z.object({ session: z.object({ id: z.string() }).loose(), reason: z.string().optional() }).loose() }),
  z.object({ category: z.literal("message"), name: z.literal("participant.join"), data: z.object({ participant: AgentParticipant }).loose() }),
  z.object({ category: z.literal("message"), name: z.literal("participant.leave"), data: z.object({ participant: AgentParticipant }).loose() }),
  z.object({ category: z.literal("message"), name: z.literal("participant.kick_all"), data: z.unknown() }),
  z.object({ category: z.literal("message"), name: z.literal("transcript.received"),
    data: z.object({
      text: z.string(),
      is_final: z.boolean(),
      started_at: z.string().optional(),
      ended_at: z.string().optional(),
      confidence: z.number().nullable().optional(),
      speaker: AgentSpeaker,
    }).loose() }),
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** Answers to our `connection.get` / `connection.ping` requests. */
export const AgentResultSchema = z.object({
  category: z.literal("result"),
  request_id: z.string().nullable(),
  name: z.string().nullable().optional(),
  data: z.unknown().nullable(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() }).loose().nullable(),
}).loose();
export type AgentResult = z.infer<typeof AgentResultSchema>;
export const ConnectionGetDataSchema = z.object({ connection: z.object({ id: z.string() }).loose() }).loose();

/** One frame of either kind; dispatch on `category` first. */
export const AgentFrameSchema = z.union([AgentMessageSchema, AgentResultSchema]);

// --- RealtimeKit REST ------------------------------------------------------

export const RtkErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.number().optional(), message: z.string(), details: z.unknown().optional() }).loose().optional(),
  errors: z.array(z.object({ code: z.number().optional(), message: z.string() }).loose()).optional(),
}).loose();

export const RtkMeetingSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  ai_config: z.unknown().optional(),
}).loose();

export const RtkParticipantSchema = z.object({ id: z.string(), token: z.string() }).loose();

export const RtkRecordingSchema = z.object({ id: z.string(), status: z.string().optional() }).loose();

export const RtkActiveSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  live_participants: z.number().optional(),
  recording_status: z.string().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().nullable().optional(),
}).loose();

export const RtkWebhookPublicKeySchema = z.object({ success: z.literal(true), data: z.object({ publicKey: z.string() }).loose() }).loose();

// --- RealtimeKit webhooks ---------------------------------------------------

const HookMeeting = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  status: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
}).loose();

const TrackDownloadUrls = z.array(z.object({
  layer_name: z.string().optional(),
  download_urls: z.record(z.string(), z.object({ download_url: z.string() }).loose()).optional(),
}).loose());

export const HookRecordingSchema = z.object({
  id: z.string().optional(),
  recordingId: z.string().optional(),
  status: z.string(),
  downloadUrl: z.union([z.string(), TrackDownloadUrls]).nullable().optional(),
  audioDownloadUrl: z.string().nullable().optional(),
  downloadUrlExpiry: z.string().nullable().optional(),
  outputFileName: z.string().nullable().optional(),
  meetingId: z.string().optional(),
  startedTime: z.string().nullable().optional(),
  stoppedTime: z.string().nullable().optional(),
  fileSize: z.number().nullable().optional(),
}).loose();

export const WebhookSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("meeting.started"), meeting: HookMeeting }).loose(),
  z.object({ event: z.literal("meeting.ended"), meeting: HookMeeting, reason: z.string().optional() }).loose(),
  z.object({ event: z.literal("meeting.participantJoined"), meeting: HookMeeting,
    participant: z.object({ peerId: z.string().optional(), userDisplayName: z.string().optional(), customParticipantId: z.string().nullable().optional(), joinedAt: z.string().optional() }).loose() }).loose(),
  z.object({ event: z.literal("meeting.participantLeft"), meeting: HookMeeting,
    participant: z.object({ peerId: z.string().optional(), userDisplayName: z.string().optional(), customParticipantId: z.string().nullable().optional(), leftAt: z.string().optional() }).loose() }).loose(),
  z.object({ event: z.literal("recording.statusUpdate"), meeting: HookMeeting, recording: HookRecordingSchema }).loose(),
]);
export type Webhook = z.infer<typeof WebhookSchema>;
/** Anything else RealtimeKit sends: accepted, logged, ignored. */
export const UnknownWebhookSchema = z.object({ event: z.string(), meeting: z.object({ id: z.string() }).loose().optional() }).loose();

// --- HTTP API bodies ----------------------------------------------------------

export const NewMeetingBodySchema = z.object({
  title: z.string().min(1).max(200),
  keywords: z.array(z.string().min(1).max(64)).max(200).optional(),
});
export const JoinBodySchema = z.object({ name: z.string().trim().min(1).max(80) });
export const JoinedBodySchema = z.object({ peerId: z.string().min(1) });

export const MeetingStatusSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: MeetingStateSchema,
  createdAt: z.number().int(),
  session: z.object({ id: z.string(), startedAt: z.number().int(), endedAt: z.number().int().nullable() }).nullable(),
  participants: z.array(ParticipantSchema),
  counts: z.object({ utterances: z.number().int(), paragraphs: z.number().int() }),
  recording: z.object({ id: z.string(), startedAt: z.number().int(), status: z.string() }).nullable(),
  copies: z.array(z.object({ kind: z.string(), key: z.string(), status: z.string(), size: z.number().int().nullable(), at: z.number().int() })),
});
export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;
