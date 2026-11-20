/**
 * zoomlk.ts — zoom.lk source adapter.
 *
 * robots.txt disallows ONLY /dlm_uploads/ — the interstitial /sub-download/<id>
 * and post pages are allowed, and /dlm_uploads/ is never touched here.
 * No WP REST: search is the `?s=<title>` HTML page, each post exposes
 * `<a href="https://zoom.lk/sub-download/<id>" class="sub-dl-btn">` + "N HITS".
 * /sub-download/<id> returns a flat ZIP with a UTF-8 BOM .srt.
 */
import { releaseScore } from '../match.ts';
import type { ScoredRow } from '../match.ts';
import { httpGet, BROWSER_UA } from '../http.ts';

const UA = BROWSER_UA;
/** Subrequest budget: 1 search + at most 4 post pages. */
const MAX_POSTS = 4;

export interface ZoomHit {
  postUrl: string;
  subDownloadId: number;
  title: string;
  hits: number;
}

/** Only https zoom.lk /sub-download/<digits> may be fetched. */
export function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 'zoom.lk' && /^\/sub-download\/\d+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Light relevance gate: at least one significant token of the wanted title must appear. */
function looksRelevant(postTitle: string, wanted: string): boolean {
  const want = new Set(tokens(wanted));
  if (want.size === 0) return true;
  return tokens(postTitle).some((t) => want.has(t));
}

const tokens = (s: string): string[] =>
  (s || '').toLowerCase().replace(/[._%]+/g, ' ').replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/[\s-]+/).filter((t) => t.length > 2 && !/^\d{4}$/.test(t));

export async function searchZoomlk(title: string, imdb: string, _season: number, _episode: number): Promise<ZoomHit[]> {
  const q = encodeURIComponent(title || imdb.replace(/^tt/, ''));
  const r = await httpGet(`https://zoom.lk/?s=${q}`, { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' });
  if (r.status !== 200) return [];
  const postLinks = [...new Set(r.text.match(/https:\/\/zoom\.lk\/[a-z0-9%.-]{8,}-sinhala-subtitle-[a-z0-9%-]*\//g) ?? [])].slice(0, MAX_POSTS);
  const out: ZoomHit[] = [];
  for (const u of postLinks) {
    const pr = await httpGet(u, { 'User-Agent': UA }).catch(() => null);
    if (!pr || pr.status !== 200) continue;
    const id = pr.text.match(/href=['"]https:\/\/zoom\.lk\/sub-download\/(\d+)['"]/)?.[1];
    if (!id) continue;
    const hitsRaw = pr.text.match(/sub-dl-badge["']?\s*>?\s*([\d,]+)\s*HITS/i)?.[1] ?? '0';
    let postTitle = '';
    try {
      postTitle = decodeURIComponent(u).split('/').filter(Boolean).pop()!.replace(/-sinhala-subtitle.*/, '').replace(/-/g, ' ');
    } catch {
      postTitle = u;
    }
    if (title && !looksRelevant(postTitle, title)) continue; // never surface a different movie
    out.push({ postUrl: u, subDownloadId: +id, title: postTitle, hits: Number(hitsRaw.replace(/,/g, '')) || 0 });
    if (out.length >= MAX_POSTS) break;
  }
  return out;
}

export function toRows(hits: ZoomHit[], videoRelease: string): ScoredRow[] {
  return hits.map((h) => ({
    id: `zoomlk:${h.subDownloadId}`,
    name: h.title || 'Sinhala subtitle',
    lang: 'sin',
    url: `https://zoom.lk/sub-download/${h.subDownloadId}`,
    origin: 'zoomlk' as const,
    score: releaseScore(h.title, videoRelease) * 0.85 + 0.1,
    human: true,
    downloads: h.hits,
  }));
}

export async function fetchZoomlk(idOrUrl: number | string): Promise<Uint8Array> {
  const url = typeof idOrUrl === 'number' ? `https://zoom.lk/sub-download/${idOrUrl}` : idOrUrl;
  if (!isAllowedUrl(url)) throw new Error('zoom.lk: url not allowed');
  const r = await httpGet(url, { 'User-Agent': UA }, 20000);
  if (r.status !== 200) throw new Error(`zoom.lk ${r.status}`);
  return r.bytes;
}
