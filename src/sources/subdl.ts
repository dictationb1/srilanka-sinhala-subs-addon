/**
 * subdl.ts — OPTIONAL source, OFF by default. SubDL's free API limits are
 * UNVERIFIED, so it is wired but returns [] unless SUBDL_API_KEY is set AND the
 * endpoint answers with the documented shape; every failure degrades silently.
 * Enable with: wrangler secret put SUBDL_API_KEY
 */
import type { ScoredRow } from '../match.ts';
import { BROWSER_UA } from '../http.ts';

interface SubDlEntry {
  SubFileName?: string;
  language?: string;
  SubDownloadLink?: string;
  SubDownloads?: number;
}

/** Only the documented SubDL download/API hosts may be fetched. */
export function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'dl.subdl.com' || u.hostname === 'api.subdl.com');
  } catch {
    return false;
  }
}

/** SubDL returns a relative download path; it lives on dl.subdl.com. */
export function absolutize(link: string | undefined): string {
  if (!link) return '';
  if (/^https?:\/\//i.test(link)) return isAllowedUrl(link) ? link : '';
  const path = link.startsWith('/') ? link : `/${link}`;
  return `https://dl.subdl.com${path}`;
}

export async function searchSubdl(imdb: string, season: number, episode: number, apiKey: string): Promise<ScoredRow[]> {
  if (!apiKey) return [];
  const parts = [`imdb_id=${encodeURIComponent(imdb)}`];
  if (season > 0) parts.push(`season=${season}`, episode > 0 ? `episode=${episode}` : 'type=tv');
  const url = `https://api.subdl.com/api/v1/subtitles?${parts.join('&')}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': BROWSER_UA } }).catch(() => null);
  if (!r || !r.ok) return [];
  const j: any = await r.json().catch(() => null);
  const subs: SubDlEntry[] = Array.isArray(j?.subtitles) ? j.subtitles : Array.isArray(j?.results) ? j.results : [];
  return subs
    .filter((s) => (s.language ?? '').toLowerCase().startsWith('si'))
    .map((s, i) => ({
      id: `subdl:${s.SubFileName ?? i}`,
      name: s.SubFileName ?? 'subtitle',
      lang: 'sin',
      url: absolutize(s.SubDownloadLink),
      origin: 'subdl' as const,
      score: 0.18,
      human: true,
      downloads: Number(s.SubDownloads ?? 0) || 0,
    }))
    .filter((row) => row.url !== '');
}
