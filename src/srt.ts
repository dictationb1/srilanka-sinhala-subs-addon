/**
 * srt.ts — cue parse/emit shared by the Worker, the translators and the tests.
 *
 * Audit fix: ASS/SSA files were fed to the SRT parser, produced ZERO cues and
 * were served as an empty 200. `parseTimed(text, ext)` now dispatches to a real
 * ASS/SSA parser, so a .ass subtitle from OpenSubtitles survives.
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** h:mm:ss,mmm — hours may be 1+ digits (ASS uses "0:00:01.00"). */
const TIME = /(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})/;

function ms(h: string, m: string, s: string, f: string): number {
  return (+h * 3600 + +m * 60 + +s) * 1000 + +f.padEnd(3, '0').slice(0, 3);
}

export function tc(millis: number): string {
  const t = Math.max(0, Math.round(millis));
  const h = Math.floor(t / 3600000);
  const m = Math.floor(t / 60000) % 60;
  const s = Math.floor(t / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(t % 1000).padStart(3, '0')}`;
}

/** Parse an SRT/VTT file into cues. Cue-setting tails ("align:start") are ignored. */
export function parseSrt(text: string): Cue[] {
  const out: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split(/\n{2,}/);
  for (const blk of blocks) {
    const lines = blk.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    let i = lines[0].trim().match(/^\d+$/) ? 1 : 0;
    if (i >= lines.length) continue;
    const m = lines[i].match(new RegExp(`${TIME.source}\\s*-->\\s*${TIME.source}`));
    if (!m) continue;
    const start = ms(m[1], m[2], m[3], m[4]);
    const end = ms(m[5], m[6], m[7], m[8]);
    const body = lines.slice(i + 1).join('\n');
    if (body.trim() !== '') out.push({ start, end, text: body });
  }
  return out;
}

/**
 * Parse ASS/SSA `[Events]` Dialogue lines into cues.
 * Format: Dialogue: layer,start,end,style,name,ml,mr,mv,effect,text
 * The text field may itself contain commas, so only the first 9 are split.
 */
export function parseAss(text: string): Cue[] {
  const out: Cue[] = [];
  const lines = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*Dialogue:\s*([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/i);
    if (!m) continue;
    const s = m[2].match(TIME);
    const e = m[3].match(TIME);
    if (!s || !e) continue;
    const body = stripMarkup(m[10].replace(/\\N/gi, '\n').replace(/\\h/gi, ' ')).trim();
    if (!body) continue;
    out.push({ start: ms(s[1], s[2], s[3], s[4]), end: ms(e[1], e[2], e[3], e[4]), text: body });
  }
  return out;
}

/** Dispatch on the container extension: ass/ssa -> parseAss, everything else -> parseSrt. */
export function parseTimed(text: string, ext: string): Cue[] {
  const e = (ext || '').toLowerCase();
  if (e === 'ass' || e === 'ssa') return parseAss(text);
  if (e === 'vtt') {
    // WEBVTT stamps are mm:ss.mmm, both before and after the "-->"; SRT needs hh:mm:ss,mmm.
    const expanded = text
      .replace(/^\s*WEBVTT.*$/m, '')
      .replace(/(^|\n|-->)\s*(\d{2}):(\d{2})[.,](\d{3})/g, (_m, lead: string, mm: string, ss: string, frac: string) => {
        const prefix = lead === '-->' ? '--> ' : lead;
        return `${prefix}00:${mm}:${ss},${frac}`;
      });
    return parseSrt(expanded);
  }
  return parseSrt(text);
}

export function emitSrt(cues: readonly Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${tc(c.start)} --> ${tc(c.end)}\n${c.text.trim()}\n`)
    .join('\n');
}

/** Strip SRT/ASS markup the player would otherwise show raw. */
export function stripMarkup(t: string): string {
  return t
    .replace(/\{\\[^}]*\}/g, '') // {\an8\c&H...&}
    .replace(/<\/?(?:font|b|i|u|ruby|p|v|span)[^>]*>/gi, '')
    .replace(/\u00a0/g, ' ')
    .trim();
}
