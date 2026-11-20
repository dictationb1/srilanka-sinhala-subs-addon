/**
 * normalize.ts — bytes of any subtitle container -> clean UTF-8 text + ext.
 *
 * Mirrors AnantPlay's SubFetch.java semantics with the audited defects fixed:
 *  - nested-folder ZIP entries are walked at ANY depth (piratelk packs
 *    "<Movie>/<name>.srt"); __MACOSX/, dotfiles and traversal are rejected
 *  - gzip (.gz), ZIP, UTF-16LE/BE and windows-1252 fallbacks (the old
 *    `new TextDecoder('utf-8', { fatal: true })` threw on every CP1252 file)
 *  - RAR4/5 and 7z are routed to the nightly pre-indexer, never dropped
 *  - watermark filter only removes real credit/ad cues ("Credit card" is dialogue)
 */
import { unzipSync, gunzipSync } from '../vendor/fflate.esm.js';
import type { Cue } from './srt.ts';

export const SUB_EXTS = ['srt', 'ass', 'ssa', 'vtt'] as const;
export type SubExt = (typeof SUB_EXTS)[number];
const RANK: Record<SubExt, number> = { srt: 0, ass: 1, ssa: 1, vtt: 2 };
/** Same zip-bomb cap as SubFetch.java MAX. */
export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;

export interface FetchedSub {
  text: string;
  ext: SubExt;
  note?: string;
}

/** A safe archive entry name: relative, no backslashes, no traversal, no dotfiles. */
const safeName = (n: string): boolean =>
  n.length > 0 && !n.startsWith('/') && !n.includes('\\') && !n.includes('..') && !n.startsWith('.');

/** Detect gzip / zip / rar4 / rar5 / 7z magic. */
export function kind(b: Uint8Array): 'gzip' | 'zip' | 'rar4' | 'rar5' | '7z' | 'raw' {
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) return 'zip';
  if (b.length >= 8 && b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1a && b[5] === 0x07) {
    return b[6] === 0x00 ? 'rar4' : 'rar5';
  }
  if (b.length >= 6 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf && b[4] === 0x27 && b[5] === 0x1c) return '7z';
  return 'raw';
}

/**
 * Entry picker for a zip: prefers .srt > .ass/.ssa > .vtt at ANY folder depth,
 * skipping __MACOSX/, dotfiles, directories and unsafe names. Between two files
 * of the same rank the first one wins (matching SubFetch's streaming order).
 */
export function pickZipEntry(names: readonly string[]): { name: string; ext: SubExt } | null {
  let best: { name: string; ext: SubExt } | null = null;
  for (const raw of names) {
    const n = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (n.length === 0 || !safeName(n) || n.includes('__MACOSX') || n.startsWith('._')) continue;
    const ext = n.toLowerCase().split('.').pop() as SubExt;
    if (!(ext in RANK)) continue;
    if (best && RANK[best.ext] <= RANK[ext]) continue;
    best = { name: n, ext };
  }
  return best;
}

/** windows-1252's 0x80–0x9F block (workerd does not guarantee legacy decoders). */
const CP1252: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
  0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function toCp1252(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += CP1252[byte] ?? String.fromCharCode(byte);
  return s;
}

/**
 * UTF-8 BOM wins, then UTF-16LE/BE BOM, then strict UTF-8, then windows-1252
 * (never throws — a legacy-encoded subtitle is still better than a 500).
 */
export function decode(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    return toCp1252(b);
  }
}

/** Packed subtitle bytes -> UTF-8 text. RAR/7z -> a note naming the pre-index route. */
export async function extract(data: ArrayBuffer | Uint8Array): Promise<FetchedSub> {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  const k = kind(b);
  if (k === 'gzip') {
    const out = gunzipSync(b);
    if (out.length > MAX_ARCHIVE_BYTES) throw new Error('unpacked subtitle over 5 MB cap');
    return { text: decode(out), ext: 'srt' };
  }
  if (k === 'zip') {
    if (b.length > MAX_ARCHIVE_BYTES) throw new Error('archive over 5 MB cap');
    const z = unzipSync(b, { filter: (f) => f.originalSize <= MAX_ARCHIVE_BYTES });
    const pick = pickZipEntry(Object.keys(z));
    if (!pick) throw new Error('no subtitle entry in zip');
    const entry = z[pick.name];
    if (!entry || entry.length === 0) throw new Error('empty subtitle entry in zip');
    return { text: decode(entry), ext: pick.ext };
  }
  if (k === 'rar4' || k === 'rar5') return { text: '', ext: 'srt', note: `rar:${k}` };
  if (k === '7z') return { text: '', ext: 'srt', note: '7z:route-to-preindexer' };
  return { text: decode(b), ext: 'srt' };
}

/**
 * Site/URL/credit watermarks. These strings never appear in real dialogue.
 * NOTE: a bare `credits?\b` alternative used to live here and stripped the
 * real line "Credit card" — do not reintroduce it.
 */
export const KNOWN_WATERMARK =
  /(opensubtitles|osdb|podnapisi|subscene|yifysubtitles|addic7ed|piratelk|pirate ?lk|zoom\.lk|zoom lk|sinhalasub|baiscope|cineru|my-subs|subsubtitle|divxsubtitle|www\.[a-z0-9-]+\.(?:lk|com|net|org)|https?:\/\/\S{6,})/i;

/** A credit line must be an actual credit phrase ("Subtitles by X", "Synced by Y"). */
const EDGE_CREDIT =
  /^(?:[[(]?\s*)?(?:(?:subtitles?|captions?|credits?|subs?)\s*(?:by|:)\s*\S.*|(?:synced|syncing|ripped|encoded|translated|corrected|timed|edited)\s+by\s+\S.*|(?:subtitles?|captions?)\s*)$/i;

/**
 * True only for ad/credit cues: at the edges (first/last 5) any credit phrase or
 * known site string, mid-file only an explicit site/domain/URL. Real dialogue —
 * including "Credit card" — can never match.
 */
export function isWatermark(text: string, cueIndex: number, totalCues: number, edge = 5): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (t.length > 240) return false; // a watermark is one short line; a long line is dialogue
  if (cueIndex < edge || cueIndex >= totalCues - edge) {
    if (EDGE_CREDIT.test(t)) return true;
    if (KNOWN_WATERMARK.test(t)) return true;
  }
  // mid-file: only explicit site/domain/URL mentions, and never sentence-like dialogue
  return KNOWN_WATERMARK.test(t) && !/[.!?…"'”]$|\b(is|are|was|the)\b/i.test(t);
}

/** Remove watermark cues, preserving the original indices' ordering. */
export function stripWatermarks<T extends { text: string }>(cues: T[], edge = 5): T[] {
  return cues.filter((c, i) => !isWatermark(stripMarkupText(c.text), i, cues.length, edge));
}

function stripMarkupText(t: string): string {
  return t.replace(/\{\\[^}]*\}/g, '').replace(/<\/?(?:font|b|i|u|ruby|p|v|span)[^>]*>/gi, '').trim();
}

/**
 * Timestamp repair: clamp reversed cues, enforce 0.5 s minimum duration, nudge
 * overlaps of up to 250 ms. Never produces end <= start.
 */
export function repairCues<T extends { start: number; end: number }>(cues: T[]): T[] {
  const out: T[] = [];
  let prevEnd = 0;
  for (const c of cues) {
    let { start, end } = c;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0) start = 0;
    if (end <= start || end - start < 500) end = start + 500;
    if (start < prevEnd && prevEnd - start <= 250) {
      start = prevEnd;
      if (end < start + 500) end = start + 500;
    }
    out.push({ ...c, start, end });
    prevEnd = Math.max(prevEnd, end);
  }
  return out;
}

/** Sinhala-safe line wrap: 38–42 chars, split only at spaces (Sinhala words are long). */
export function wrap(text: string, width = 40): string {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (para.length <= width) {
      lines.push(para);
      continue;
    }
    const words = para.split(' ');
    let cur = '';
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > width) {
        lines.push(cur);
        cur = w;
      } else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) lines.push(cur);
  }
  return lines.join('\n');
}

/** Re-exported for callers that only need cue shape. */
export type { Cue };
