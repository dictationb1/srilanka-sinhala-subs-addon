/**
 * piratelk.ts — piratelk.com source adapter (the site's own WordPress REST API).
 *
 * robots.txt: "User-agent: * / Disallow:" (fully open).
 * `/wp-json/wp/v2/posts?search=` bypasses the site's Cloudflare search wall and
 * returns the post HTML (with the IMDb id and the /download/<slug>/ href).
 * Downloads are nested-folder ZIPs: "<Movie> (Year) - Piratelk.com/<name>.srt".
 */
import { releaseScore } from '../match.ts';
import type { ScoredRow } from '../match.ts';
import { httpGet, BROWSER_UA } from '../http.ts';

const UA = BROWSER_UA;
const HOSTS = new Set(['piratelk.com', 'www.piratelk.com']);

export interface SourceHit {
  slug: string;
  postUrl: string;
  title: string;
  imdb?: string;
  dlUrl: string;
  release?: string;
}

/** Only https piratelk.com URLs may ever be fetched (token tampering -> SSRF defence). */
export function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && HOSTS.has(u.hostname.toLowerCase()) && u.pathname.startsWith('/download/');
  } catch {
    return false;
  }
}

export async function searchPiratelk(imdb: string, _season: number, _episode: number, videoName = ''): Promise<SourceHit[]> {
  // The API needs a title, not an id: strip the year from the release name, fall back to imdb digits.
  const q = encodeURIComponent(titleFrom(videoName) || imdb.replace(/^tt/, ''));
  const r = await httpGet(`https://piratelk.com/wp-json/wp/v2/posts?search=${q}&per_page=10`, {
    'User-Agent': UA,
    Accept: 'application/json',
  });
  if (r.status !== 200) return [];
  let posts: any[];
  try {
    const parsed = JSON.parse(r.text);
    posts = Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // HTML error page / Cloudflare interstitial — never throw at the router
  }
  const out: SourceHit[] = [];
  for (const p of posts) {
    const html: string = p?.content?.rendered ?? '';
    const ids: string[] = html.match(/tt\d{7,9}/g) ?? [];
    const dl = html.match(/href="([^"]*\/download\/[^"]*)"/)?.[1] ?? '';
    if (!dl) continue;
    const dlUrl = dl.replace(/&amp;/g, '&');
    if (!isAllowedUrl(dlUrl)) continue; // never emit a row we would refuse to fetch
    if (imdb && ids.length && !ids.includes(imdb)) continue; // wrong movie safety
    const slug: string = p?.slug ?? '';
    const title: string = stripTitle(p?.title?.rendered ?? slug);
    out.push({ slug, postUrl: p?.link ?? '', title, imdb: ids[0], dlUrl, release: title });
  }
  return out;
}

const titleFrom = (release: string) => (release || '').replace(/[._]/g, ' ').replace(/\s*\(?\d{4}\)?.*$/, '').trim().slice(0, 60);

const stripTitle = (t: string) =>
  (t || '').replace(/&#8211;|&#8212;/g, '-').replace(/<[^>]+>/g, '').replace(/\s*සිංහල.*$/, '').replace(/\s+/g, ' ').trim();

/** Convert hits to rows, scored against the video release name. */
export function toRows(hits: SourceHit[], videoRelease: string): ScoredRow[] {
  return hits.map((h) => ({
    id: `piratelk:${h.slug || h.dlUrl}`,
    name: h.title || 'Sinhala subtitle',
    lang: 'sin',
    url: h.dlUrl,
    origin: 'piratelk' as const,
    score: releaseScore(h.release ?? h.title, videoRelease) * 0.9 + 0.1,
    human: true,
    downloads: 0,
  }));
}

export async function fetchPiratelk(dlUrl: string): Promise<Uint8Array> {
  if (!isAllowedUrl(dlUrl)) throw new Error('piratelk: url not allowed');
  const r = await httpGet(dlUrl, { 'User-Agent': UA, Accept: '*/*' }, 20000);
  if (r.status !== 200) throw new Error(`piratelk ${r.status}`);
  return r.bytes;
}
