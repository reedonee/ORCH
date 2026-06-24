// ── Groq STT Client ──────────────────────────────────────────────
// Premium fallback transcription engine. Assembles raw Float32 PCM
// frames into a strict mono 16kHz WAV blob, then POSTs to Groq's
// whisper-large-v3-turbo edge nodes using the user's BYOK key.
//
// Only invoked when local Whisper tiny.en returns a result that
// fails our intent/hotword validation (empty, gibberish, or no
// recognizable action keywords).
//
// WAV header: 44 bytes, RIFF, PCM, 1ch, 16bit, 16000Hz

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';

export interface GroqSttResult {
  text: string;
  success: boolean;
  error?: string;
}

/**
 * Build a strict RIFF WAV header for mono 16-bit PCM at 16000Hz.
 * Exactly 44 bytes — no extended chunks, no padding.
 */
function buildWavHeader(dataByteLength: number): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);

  const sampleRate = 16000;
  const bitsPerSample = 16;
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  // RIFF chunk descriptor
  writeString(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataByteLength, true); // file size - 8
  writeString(dv, 8, 'WAVE');

  // fmt sub-chunk
  writeString(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);           // sub-chunk size (PCM)
  dv.setUint16(20, 1, true);            // audio format (1 = PCM)
  dv.setUint16(22, numChannels, true);  // mono
  dv.setUint32(24, sampleRate, true);   // 16000 Hz
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(dv, 36, 'data');
  dv.setUint32(40, dataByteLength, true);

  return header;
}

function writeString(dv: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    dv.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Convert an array of Float32 PCM samples (normalised -1..1) into
 * a mono 16-bit 16000Hz WAV Blob suitable for direct POST to Groq.
 */
export function pcmFramesToWavBlob(frames: Float32Array): Blob {
  // Float32 → Int16 (clamp to ±32767)
  const int16 = new Int16Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const s = Math.max(-1, Math.min(1, frames[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  const dataBytes = int16.byteLength;
  const header = buildWavHeader(dataBytes);

  // Concatenate header + PCM data into one Blob
  return new Blob([header, int16.buffer], { type: 'audio/wav' });
}

/**
 * Transcribe a WAV Blob using Groq's whisper-large-v3-turbo.
 * Returns the transcript text on success, or an error message.
 */
export async function transcribeWithGroq(
  wavBlob: Blob,
  apiKey: string,
  signal?: AbortSignal,
): Promise<GroqSttResult> {
  try {
    const formData = new FormData();
    formData.append('file', wavBlob, 'orch_capture.wav');
    formData.append('model', GROQ_MODEL);
    formData.append('response_format', 'json');
    formData.append('language', 'en');

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        // Note: no Content-Type — fetch sets multipart/form-data with boundary
      },
      body: formData,
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        text: '',
        success: false,
        error: `Groq HTTP ${response.status}: ${body.slice(0, 200)}`,
      };
    }

    const data = await response.json();
    const text = (data.text || '').trim();
    return { text, success: text.length > 0 };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { text: '', success: false, error: 'Aborted' };
    }
    return {
      text: '',
      success: false,
      error: err?.message || 'Groq request failed',
    };
  }
}

// ── Intent validation helpers ─────────────────────────────────

/**
 * Known action-triggering keywords that our voice pipeline acts on.
 * If the transcript contains none of these, local Whisper likely
 * hallucinated or heard noise — a candidate for Groq fallback.
 */
const ACTION_KEYWORDS = [
  'spawn', 'create', 'make', 'add', 'new',
  'vanish', 'kill', 'remove', 'delete', 'close', 'destroy',
  'arrange', 'tidy', 'grid', 'organize', 'layout',
  'focus', 'center', 'zoom', 'select',
  'hello', 'hi', 'hey', 'status', 'help',
  'who', 'what', 'where', 'how', 'why',
  'open', 'launch', 'run', 'start', 'stop',
  'talk', 'speak', 'say', 'voice',
];

const GIBBERISH_PATTERN = /^[^a-zA-Z0-9\s]{4,}$/;

/**
 * Common English dictionary words (top ~200) plus domain terms.
 * Used to compute real-word density for gibberish detection.
 */
const COMMON_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'over', 'after',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'may', 'might',
  'shall', 'must', 'need', 'dare', 'ought',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
  'this', 'that', 'these', 'those', 'some', 'any', 'each', 'every', 'all', 'both',
  'no', 'not', 'none', 'nothing', 'nobody', 'nowhere',
  'here', 'there', 'where', 'when', 'why', 'how', 'what', 'which', 'who', 'whom',
  'please', 'yes', 'no', 'ok', 'okay', 'thanks', 'thank', 'sorry',
  'hello', 'hi', 'hey', 'bye', 'goodbye', 'see', 'later',
  'can', 'will', 'let', 'go', 'get', 'make', 'open', 'close',
  'agent', 'code', 'claude', 'hermes', 'orch', 'orchestra',
  'terminal', 'canvas', 'prompt', 'focus', 'stop', 'start', 'run',
  'spawn', 'create', 'add', 'remove', 'delete', 'kill', 'vanish',
  'arrange', 'layout', 'grid', 'tidy', 'help', 'status', 'talk', 'speak',
  'say', 'hello', 'show', 'tell', 'ask', 'need', 'want', 'like',
  'just', 'now', 'then', 'try', 'use', 'set', 'check', 'find',
  // Agent names
  'max', 'sky', 'zuma', 'astra', 'chase', 'zed', 'eve', 'blade', 'blue', 'lily',
]);

/** Commas between many single-letter words = classic tiny.en hallucination pattern. */
const COMMA_SALAD_PATTERN = /,\s*[a-z]\s*,/i;

/** Repeated identical word patterns like "cloud cloud" or "agent agent". */
const REPEATED_WORD_PATTERN = /\b(\w{2,})\s+\1\b/i;

/** Known bad substitutions that tiny.en produces for domain terms. */
const BAD_SUBSTITUTIONS = /\b(cold|close(?=\s+agent)|called|cloud|codec)\b/i;

/**
 * Compute the fraction of words that are in the common word list.
 * For garbled output, this ratio is much lower than real speech.
 */
function dictionaryWordRatio(text: string): number {
  const words = text.toLowerCase().split(/[\s,]+/).filter(w => w.length > 0);
  if (words.length === 0) return 0;
  const known = words.filter(w => COMMON_WORDS.has(w)).length;
  return known / words.length;
}

/**
 * Check whether a local Whisper transcript is usable or should be
 * escalated to Groq for re-transcription.
 *
 * Returns `true` if the transcript passes validation (usable as-is).
 * Returns `false` if Groq fallback should be attempted.
 *
 * Enhanced with:
 *  - Dictionary word density check (catches "open, a close, called agent.")
 *  - Comma-salad pattern (many single-letter words separated by commas)
 *  - Repeated word pattern ("cloud cloud")
 *  - Known bad substitution detection ("cold" → Claude, "called" → Code)
 */
export function isTranscriptValid(text: string): boolean {
  const trimmed = text.trim();

  // Empty → fallback
  if (!trimmed) return false;

  // Very short gibberish (no real words) → fallback
  if (trimmed.length <= 2) return false;

  // Mostly non-alphanumeric chars → fallback
  if (GIBBERISH_PATTERN.test(trimmed)) return false;

  // ── Enhanced heuristics ──────────────────────────────────────

  // Comma salad: "open, a close, called agent." → comma-separated short words
  if (COMMA_SALAD_PATTERN.test(trimmed)) return false;

  // Repeated words: "cloud cloud", "agent agent" → classic hallucination
  if (REPEATED_WORD_PATTERN.test(trimmed)) return false;

  // Known bad substitutions that tiny.en produces for ORCH domain terms
  if (BAD_SUBSTITUTIONS.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  const hasKeyword = ACTION_KEYWORDS.some((kw) => lower.includes(kw));
  const looksLikeSpeech = trimmed.split(/\s+/).length >= 2 && /[a-z]{3,}/i.test(trimmed);

  // ── Dictionary word density: if <40% of words are real English, it's garbled
  const wordRatio = dictionaryWordRatio(trimmed);
  if (hasKeyword && wordRatio < 0.4) return false;

  // Check for single-letter word count: garbled output has many
  const words = trimmed.split(/[\s,]+/).filter(w => w.length > 0);
  const singleLetterWords = words.filter(w => w.length === 1 && /[a-zA-Z]/.test(w)).length;
  if (singleLetterWords / words.length > 0.3) return false;

  return hasKeyword || looksLikeSpeech;
}
