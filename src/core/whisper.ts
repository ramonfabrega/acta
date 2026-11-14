// Whisper large-v3-turbo on Workers AI: the request we send and the answer we
// accept. The Worker runs it on a track already in R2 (docs/BATCH.md); the
// CLI turns the words into rows. Vendor output is `.loose()`: an added field
// never breaks a batch pass.
import { z } from "zod";

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

export const TranscribeBodySchema = z.object({
  /** File name under `recordings/` in the meeting's R2 prefix, as `acta sync` lists it. */
  track: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/),
  language: z.string().min(2).max(8).optional(),
  /** The meeting's keywords, joined: Whisper's prompt is the one place vocabulary goes. */
  initialPrompt: z.string().max(2000).optional(),
  /** Voice activity detection before decoding: a per-speaker track is mostly silence, and Whisper hallucinates on silence. */
  vadFilter: z.boolean().optional(),
  conditionOnPreviousText: z.boolean().optional(),
  noSpeechThreshold: z.number().min(0).max(1).optional(),
  hallucinationSilenceThreshold: z.number().positive().optional(),
});
export type TranscribeBody = z.infer<typeof TranscribeBodySchema>;

export const WhisperWordSchema = z.object({ word: z.string(), start: z.number(), end: z.number() }).loose();
export const WhisperSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  avg_logprob: z.number().optional(),
  no_speech_prob: z.number().optional(),
  compression_ratio: z.number().optional(),
  temperature: z.number().optional(),
  words: z.array(WhisperWordSchema).default([]),
}).loose();
export const WhisperOutputSchema = z.object({
  text: z.string(),
  word_count: z.number().optional(),
  transcription_info: z.object({
    language: z.string().optional(),
    language_probability: z.number().optional(),
    duration: z.number().optional(),
    duration_after_vad: z.number().optional(),
  }).loose().optional(),
  segments: z.array(WhisperSegmentSchema).default([]),
  vtt: z.string().optional(),
}).loose();
export type WhisperOutput = z.infer<typeof WhisperOutputSchema>;

/** What `POST /api/meetings/:id/transcribe` answers: the model's output and what the call cost in time and bytes. */
export const TranscribeAnswerSchema = z.object({
  track: z.string(),
  bytes: z.number().int(),
  model: z.string(),
  ms: z.number().int(),
  output: WhisperOutputSchema,
});
export type TranscribeAnswer = z.infer<typeof TranscribeAnswerSchema>;
