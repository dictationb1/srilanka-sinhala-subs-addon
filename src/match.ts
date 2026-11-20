/**
 * match.ts — release-tag scorer + the si<->sin normalizer used everywhere.
 *
 * AnantPlay filters Stremio rows with `osCode(s.lang).equals(code)` (Subs.java
 * "search"), and Android's ISO3 code for Sinhala is "sin". Rows therefore MUST
 * carry "sin": a "si" row is silently dropped by `equals`.
 */

/** Canonical language code AnantPlay/OpenSubtitles expect: ISO 639-2/B "sin". */
export function toSin(lang: string): string {
  const l = (lang || '').trim().toLowerCase().replace('_', '-');
  if (l === 'si' || l === 'sin' || l === 'sinh' || l === 'si-lk' || l === 'sin-lk') return 'sin';
  return l;
}

/** Stremio clients may send either code; normalize query params the same way. */
export function normLangParam(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const l = toSin(v);
  return l.length === 2 || l.length === 3 ? l : undefined;
}

const STOP = new Set(['brrip', 'bluray', 'blu-ray', 'webrip', 'web', 'webdl', 'web-dl', 'dvdrip', 'dvdscr', 'hdtv',
  'hdrip', 'camrip', 'hd', 'sd', 'hq', 'hdrc', 'hdr', 'aac', 'ac3', 'dts', 'dolby', 'x264', 'x265', 'h264', 'h265',
  'hevc', 'xvid', 'divx', 'avc', '1080p', '720p', '480p', '360p', '2160p', 'mp3', 'aac2', '10bit', '8bit', 'remastered',
  'extended', 'unrated', 'imax', 'proper', 'repack', 'internal', 'limited', 'complete', 'season', 's01']);

const tokenize = (s: string): string[] =>
  (s || '').toLowerCase().replace(/[._[\]()]+/g, ' ').split(/[\s-]+/).filter((t) => t.length > 1 && !STOP.has(t));

/**
 * Lowercase Jaccard over tokens + release-group bonus captured AFTER the final
 * hyphen (-ntb, -yts, -avc, -flux). Year mismatch halves the score.
 */
export function releaseScore(subRelease: string, videoRelease: string): number {
  const pick = (s: string): { tokens: Set<string>; group: string } => {
    const raw = (s || '').toLowerCase().trim();
    const group = (raw.split('-').pop() || '').replace(/[^\w]/g, '');
    return { tokens: new Set(tokenize(raw)), group };
  };
  const a = pick(subRelease), b = pick(videoRelease);
  if (a.tokens.size === 0 || b.tokens.size === 0) return 0;
  let inter = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) inter++;
  let j = inter / (a.tokens.size + b.tokens.size - inter);
  if (a.group && a.group === b.group && a.group.length >= 2) j = Math.min(1, j + 0.25);
  const yearA = subRelease.match(/(19|20)\d{2}/)?.[0], yearB = videoRelease.match(/(19|20)\d{2}/)?.[0];
  if (yearA && yearB && yearA !== yearB) j *= 0.5;
  return j;
}

export interface ScoredRow {
  id: string;
  name: string;
  lang: string;
  url: string;
  downloads?: number;
  hearingImpaired?: boolean;
  origin: 'piratelk' | 'zoomlk' | 'opensubsLegacy' | 'opensubsSin' | 'subdl' | 'geminiTranslated' | 'preindexed';
  score: number;
  human: boolean;
}

/** Sort: human first, then score, then downloads. Duplicate upstream URLs are collapsed. */
export function rank(rows: ScoredRow[], wantLang = 'sin'): ScoredRow[] {
  const seen = new Set<string>();
  return rows
    .map((r) => ({ ...r, lang: toSin(r.lang) }))
    .filter((r) => r.lang === toSin(wantLang))
    .filter((r) => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .sort((a, b) => (Number(b.human) - Number(a.human)) || (b.score - a.score) || ((b.downloads || 0) - (a.downloads || 0)));
}

/** IMDb / season / episode extractor for the Stremio route params. */
export function parseVideoId(type: string, id: string): { imdb: string; season: number; episode: number } | null {
  const imdb = id.match(/tt\d{7,9}/)?.[0];
  if (!imdb) return null;
  if (type === 'series') {
    const m = id.match(/:(\d+):(\d+)$/);
    return { imdb, season: m ? +m[1] : 0, episode: m ? +m[2] : 0 };
  }
  return { imdb, season: 0, episode: 0 };
}
