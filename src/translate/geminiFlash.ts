/**
 * geminiFlash.ts — PRIMARY translator: Gemini 2.5 Flash via the Google AI Studio
 * REST API (free tier key, no billing card needed).
 *
 * Subrequest budget (Worker free tier: 50): a movie is split into **at most 6**
 * batches regardless of cue count (1500 cues -> 5 x ~320; a 3000-cue marathon ->
 * 6 x 500), fetched in parallel. With one retry and one split fallback the true
 * worst case is ~18 subrequests, still far below the cap.
 *
 * Validation is strict: the answer must be a JSON object covering every cue
 * number; a bad batch is retried once, then split in half, and only then are
 * the remaining cues passed through untranslated (never silently dropped).
 */
import { parseSrt, emitSrt, stripMarkup, type Cue } from '../srt.ts';
import { stripWatermarks, repairCues, wrap } from '../normalize.ts';

export interface TranslateOpts {
  title: string;
  year?: string;
  kind?: string;
  maxBatch?: number;
  signal?: AbortSignal;
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';
/** Hard ceiling on translation subrequests per movie. */
export const MAX_SUBREQUESTS = 6;
/** Comfortable prompt size for one batch (≈250-350 cues of dialogue). */
export const DEFAULT_BATCH = 320;

/** Batch plan: never more than MAX_SUBREQUESTS batches, whatever the cue count. */
export function planBatches(count: number, maxBatch = DEFAULT_BATCH): number[][] {
  if (count <= 0) return [];
  const size = Math.max(maxBatch, Math.ceil(count / MAX_SUBREQUESTS));
  const out: number[][] = [];
  for (let i = 0; i < count; i += size) {
    const batch: number[] = [];
    for (let j = i; j < Math.min(count, i + size); j++) batch.push(j);
    out.push(batch);
  }
  return out;
}

const ts = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  return `${String(Math.floor(t / 3600000)).padStart(2, '0')}:${String(Math.floor(t / 60000) % 60).padStart(2, '0')}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')},${String(t % 1000).padStart(3, '0')}`;
};

/** The movie-dialogue prompt: natural SPOKEN Sinhala, not stiff written register. */
export function buildPrompt(cues: Cue[], o: TranslateOpts): string {
  const numbered = cues
    .map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${stripMarkup(c.text).replace(/\n/g, ' | ')}`)
    .join('\n\n');
  return `You are a professional Sri Lankan subtitler. Translate these English movie subtitles into natural, SPOKEN colloquial Sinhala (සිංහල) — the register friends use when talking, not formal written Sinhala. Movie: "${o.title}"${o.year ? ` (${o.year})` : ''}${o.kind ? `, genre: ${o.kind}` : ''}.

Rules:
- Keep each subtitle short enough to read in its time (2 lines max).
- Keep names in English. Keep numbers as digits. Interjections can stay (Oh, Wait...).
- No transliteration of English words when a common Sinhala word exists.
- Translate line by line. The "|" separator separates the original line breaks; output the same lines translated.

Return ONLY a JSON object mapping cue numbers to Sinhala text, exactly: {"1": "...", "2": "..."} for all ${cues.length} cues. No markdown, no commentary.

Subtitles:
${numbered}`;
}

interface GeminiResp {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  error?: { message?: string };
}

async function callGemini(apiKey: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${BASE}/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: signal ?? AbortSignal.timeout(60000),
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 32768, responseMimeType: 'application/json' },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as GeminiResp;
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) throw new Error('Gemini empty response');
  return text;
}

/** Parse the model's answer into a cue-number -> text map. Throws when incomplete. */
export function parseAnswer(answer: string, expected: number): Map<number, string> {
  const cleaned = answer.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in answer');
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const map = new Map<number, string>();
  for (const [k, v] of Object.entries(obj)) {
    const n = +k;
    if (Number.isInteger(n) && n >= 1 && n <= expected && typeof v === 'string' && v.trim() !== '') map.set(n, v.trim());
  }
  if (map.size < expected) throw new Error(`incomplete batch: ${map.size}/${expected} cues`);
  return map;
}

/** Shared request budget so retries + splits can never blow the subrequest cap. */
interface Budget {
  left: number;
}

/**
 * One batch: ask, retry once, then split in half (max depth 2).
 * Every Gemini call decrements the shared budget; when it runs out the remaining
 * cues are passed through untranslated instead of hammering the API.
 */
async function translateBatch(
  apiKey: string,
  cues: Cue[],
  o: TranslateOpts,
  budget: Budget,
  depth = 0,
): Promise<Array<string | undefined>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (budget.left <= 0) return cues.map(() => undefined);
    budget.left--;
    try {
      const ans = await callGemini(apiKey, buildPrompt(cues, o), o.signal);
      const map = parseAnswer(ans, cues.length);
      return cues.map((_, i) => map.get(i + 1));
    } catch {
      if (attempt === 0) await new Promise((res) => setTimeout(res, 400));
    }
  }
  if (depth >= 2 || cues.length < 8) return cues.map(() => undefined);
  const mid = Math.ceil(cues.length / 2);
  const left = await translateBatch(apiKey, cues.slice(0, mid), o, budget, depth + 1);
  const right = await translateBatch(apiKey, cues.slice(mid), o, budget, depth + 1);
  return [...left, ...right];
}

/** Hard ceiling for one movie: 6 planned batches + retries/splits, far below 50. */
export const MAX_TOTAL_REQUESTS = MAX_SUBREQUESTS * 3;

/** Translate cues with parallel batches; timestamps are copied verbatim. */
export async function translateCues(
  apiKey: string,
  cues: Cue[],
  o: TranslateOpts,
  onProgress?: (done: number, total: number) => void,
): Promise<Cue[]> {
  const batches = planBatches(cues.length, o.maxBatch);
  const out = new Array<string | undefined>(cues.length);
  const budget: Budget = { left: MAX_TOTAL_REQUESTS };
  let done = 0;
  await Promise.all(
    batches.map(async (idx) => {
      const slice = idx.map((i) => cues[i]);
      const got = await translateBatch(apiKey, slice, o, budget);
      idx.forEach((i, j) => (out[i] = got[j]));
      done += idx.length;
      if (onProgress) onProgress(done, cues.length);
    }),
  );
  const missing = out.filter((t) => !t || t.trim() === '').length;
  if (missing > Math.floor(cues.length * 0.05)) {
    throw new Error(`translation incomplete: ${missing}/${cues.length} cues missing`);
  }
  return cues.map((c, i) => ({ start: c.start, end: c.end, text: out[i] ?? c.text }));
}

/** Full pipeline used by the Worker: parse -> strip watermarks -> translate -> repair -> wrap -> emit. */
export async function translateSrt(apiKey: string, srtText: string, o: TranslateOpts): Promise<string> {
  let cues = parseSrt(srtText);
  cues = stripWatermarks(cues);
  cues = repairCues(cues);
  if (cues.length === 0) throw new Error('no cues to translate');
  const translated = await translateCues(apiKey, cues, o);
  const wrapped = translated.map((c) => ({ ...c, text: wrap(c.text, 40) }));
  return emitSrt(wrapped);
}
