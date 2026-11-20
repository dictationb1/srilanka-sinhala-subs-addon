/**
 * googleV3.ts — OPTIONAL secondary translator (env TRANSLATOR_PROVIDER=google_v3):
 * Google Cloud Translation v2/v3 via API key. Stiffer register than Gemini but a
 * stable fallback when the AI Studio key is unavailable.
 */
import { parseSrt, emitSrt, stripMarkup, type Cue } from '../srt.ts';
import { stripWatermarks, repairCues, wrap } from '../normalize.ts';

const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
/** v2 accepts up to 128 q strings per request. */
const BATCH = 128;

export async function translateBatch(apiKey: string, texts: string[], source = 'en', target = 'si'): Promise<string[]> {
  const r = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ q: texts, source, target, format: 'text' }),
  });
  if (!r.ok) throw new Error(`googleV3 ${r.status}`);
  const j: any = await r.json();
  const out: string[] = j?.data?.translations?.map((t: { translatedText: string }) => t.translatedText) ?? [];
  if (out.length !== texts.length) throw new Error(`googleV3 count mismatch: ${out.length}/${texts.length}`);
  return out;
}

/** Batched v3 translation with the same cue-count validation as the Gemini path. */
export async function translateSrt(apiKey: string, srtText: string, _opts: { title: string }): Promise<string> {
  let cues: Cue[] = parseSrt(srtText);
  cues = stripWatermarks(cues);
  cues = repairCues(cues);
  if (cues.length === 0) throw new Error('no cues to translate');
  const outTexts: string[] = [];
  for (let i = 0; i < cues.length; i += BATCH) {
    const slice = cues.slice(i, i + BATCH).map((c) => stripMarkup(c.text).replace(/\n/g, ' '));
    outTexts.push(...(await translateBatch(apiKey, slice)));
  }
  const translated: Cue[] = cues.map((c, i) => ({ start: c.start, end: c.end, text: wrap(outTexts[i] ?? c.text, 40) }));
  return emitSrt(translated);
}
