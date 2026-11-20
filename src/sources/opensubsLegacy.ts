/**
 * opensubsLegacy.ts — OpenSubtitles legacy REST (rest.opensubtitles.org/search/),
 * the API AnantPlay's SubOs.java already speaks. Returns a JSON array; the
 * SubDownloadLink is a .gz gzip; SubLanguageID for Sinhala is "sin".
 * The legacy API requires the "TemporaryUserAgent" user agent.
 */
import type { ScoredRow } from '../match.ts';
import { httpGet } from '../http.ts';

const UA = 'TemporaryUserAgent'; // AnantPlay SubOs.java requirement

export interface OsResult {
  id: string;
  name: string;
  lang: string;
  url: string;
  downloads: number;
  hearingImpaired: boolean;
  encoding: string;
}

/** Only https *.opensubtitles.org may be fetched (search + dl hosts). */
export function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (h === 'opensubtitles.org' || h.endsWith('.opensubtitles.org'));
  } catch {
    return false;
  }
}

/** Exact SubOs.java url() segment order: episode / imdbid / season / sublanguageid. */
export function urlFor(imdb: string, season: number, episode: number, lang: string): string {
  const digits = imdb.replace(/^tt/i, '');
  const ep = season > 0 || episode > 0;
  const pad = digits.padStart(7, '0');
  const parts = ['https://rest.opensubtitles.org/search/'];
  if (ep) parts.push(`episode-${episode}/`);
  parts.push(`imdbid-${pad}`);
  if (ep) parts.push(`/season-${season}`);
  parts.push(`/sublanguageid-${lang}`);
  return parts.join('');
}

export async function searchOpenSubs(imdb: string, season: number, episode: number, lang: 'sin' | 'eng'): Promise<OsResult[]> {
  const r = await httpGet(urlFor(imdb, season, episode, lang), { 'User-Agent': UA }, 20000);
  if (r.status !== 200 || !r.text.trim().startsWith('[')) return [];
  let a: any[];
  try {
    const parsed = JSON.parse(r.text);
    a = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
  const out: OsResult[] = [];
  for (const o of a) {
    if (o?.SubBad === '1') continue;
    const fmt = String(o?.SubFormat ?? 'srt').toLowerCase();
    if (!['srt', 'ass', 'ssa', 'vtt'].includes(fmt)) continue;
    const u: string = o?.SubDownloadLink ?? '';
    if (!u || !isAllowedUrl(u)) continue;
    out.push({
      id: `os:${o.IDSubtitle}`,
      name: o?.SubFileName ?? o?.MovieReleaseName ?? 'subtitle',
      lang: o?.SubLanguageID ?? lang,
      url: u,
      downloads: Number(o?.SubDownloadsCnt ?? 0) || 0,
      hearingImpaired: o?.SubHearingImpaired === '1',
      encoding: o?.SubEncoding ?? '',
    });
  }
  out.sort((a, b) => b.downloads - a.downloads);
  return out.slice(0, 40);
}

export function toRows(res: OsResult[]): ScoredRow[] {
  return res.map((x) => ({
    id: x.id,
    name: x.name,
    lang: x.lang,
    url: x.url,
    origin: 'opensubsSin' as const,
    score: 0.2,
    human: true,
    downloads: x.downloads,
    hearingImpaired: x.hearingImpaired,
  }));
}

export async function fetchOpenSubs(gzUrl: string): Promise<Uint8Array> {
  if (!isAllowedUrl(gzUrl)) throw new Error('opensubtitles: url not allowed');
  const r = await httpGet(gzUrl, { 'User-Agent': UA }, 20000);
  if (r.status !== 200) throw new Error(`opensubtitles ${r.status}`);
  return r.bytes;
}
