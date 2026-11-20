/**
 * index.ts — srilanka-sinhala-subs-addon: Stremio-protocol subtitle addon on a
 * Cloudflare Worker (pure TS: fflate for zip/gzip, no binaries).
 *
 * Routes:
 *   GET /manifest.json
 *   GET /subtitles/:type/:id.json[?videoRelease=]   -> Stremio rows ("lang":"sin")
 *   GET /download/:token.srt                        -> clean UTF-8 SRT; 202 while translating
 *   GET /health                                     -> per-source live check
 *
 * Contract notes verified against the real AnantPlay sources (2026-11-20):
 *   - Subs.java filters rows with `osCode(s.lang).equals(code)`: every row must
 *     carry "sin", never "si", or the row is dropped.
 *   - Subs.find() hands `url` straight to HttpURLConnection, so a relative URL
 *     throws and the whole addon looks empty. Rows are emitted as ABSOLUTE URLs.
 *   - SubFetch rejects any body without "-->" (so a 202 body is a safe retry
 *     signal) and caps archives at 5 MB.
 */
import { toSin, rank, parseVideoId, type ScoredRow } from './match.ts';
import { emitSrt, parseTimed } from './srt.ts';
import { extract, stripWatermarks, repairCues, type FetchedSub } from './normalize.ts';
import { cacheGet, cachePut, preindexGet, tryLock, unlock } from './cache.ts';
import { encodeToken, decodeToken, type TokenPayload } from './token.ts';
import { httpGet, BROWSER_UA } from './http.ts';
import { searchPiratelk, toRows as plRows, fetchPiratelk, isAllowedUrl as plAllowed } from './sources/piratelk.ts';
import { searchZoomlk, toRows as zlRows, fetchZoomlk, isAllowedUrl as zlAllowed } from './sources/zoomlk.ts';
import { searchOpenSubs, toRows as osRows, fetchOpenSubs, isAllowedUrl as osAllowed } from './sources/opensubsLegacy.ts';
import { searchSubdl, isAllowedUrl as sdAllowed } from './sources/subdl.ts';
import { translateSrt as geminiTranslate } from './translate/geminiFlash.ts';
import { translateSrt as googleTranslate } from './translate/googleV3.ts';
import type { Env } from './env.ts';

export type { Env };

const ADDON_ID = 'srilanka.sinhala.subs';
const ADDON_VERSION = '1.1.0';
const ADDON_NAME = 'Sri Lanka Sinhala Subtitles';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Retry-After',
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const err = (status: number, msg: string) => json({ error: msg }, status);

/** A downloadable subtitle response may be cached by clients/CDN for a day. */
const okHeaders = (): Record<string, string> => ({
  'Content-Type': 'text/plain; charset=utf-8',
  ...CORS,
  'Cache-Control': 'public, max-age=86400',
});

/** 202/4xx must never be cached, or a client pins a "retry later" body for a day. */
const pendingHeaders = (retryAfter: number): Record<string, string> => ({
  'Content-Type': 'text/plain; charset=utf-8',
  ...CORS,
  'Cache-Control': 'no-store',
  'Retry-After': String(retryAfter),
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET' && req.method !== 'HEAD') return err(405, 'method not allowed');
    try {
      if (path === '/manifest.json') return json(manifest());
      if (path === '/health') return json(await health());
      const sub = path.match(/^\/subtitles\/(movie|series)\/(.+?)\.json$/i);
      if (sub) return await subtitlesRoute(u, sub[1].toLowerCase(), sub[2], env);
      const dl = path.match(/^\/download\/([A-Za-z0-9_-]{8,1200})\.srt$/);
      if (dl) return await downloadRoute(dl[1], env, ctx);
      return err(404, 'not found');
    } catch (e) {
      return err(500, String((e as Error)?.message ?? e));
    }
  },
};

export function manifest() {
  return {
    id: ADDON_ID,
    name: ADDON_NAME,
    description:
      'සිංහල උපසිරැසි — piratelk.com + zoom.lk + OpenSubtitles, plus English→Sinhala translation when no Sinhala file exists.',
    version: ADDON_VERSION,
    resources: [{ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
  };
}

export interface Row {
  id: string;
  name: string;
  lang: string;
  url: string;
  downloads?: number;
  hearingImpaired?: boolean;
  origin: string;
  score: number;
  human: boolean;
}

async function subtitlesRoute(u: URL, type: string, id: string, env: Env): Promise<Response> {
  const vid = parseVideoId(type, id);
  if (!vid) return json({ subtitles: [] });
  const videoRelease =
    u.searchParams.get('videoRelease') ?? u.searchParams.get('filename') ?? u.searchParams.get('name') ?? '';
  const rows = await collectRows(vid, videoRelease, env);
  const origin = `${u.protocol}//${u.host}`;
  return json({ subtitles: rows.map((r) => publicRow(r, origin)), cacheMaxAge: 3600, staleRevalidate: 86400 });
}

/** Public Stremio shape: absolute url, lang "sin", name+label for older clients. */
function publicRow(r: Row, origin: string) {
  const url = /^https?:\/\//i.test(r.url) ? r.url : new URL(r.url, origin).toString();
  return {
    id: r.id,
    url,
    lang: toSin(r.lang),
    name: r.name,
    label: r.name,
    ...(r.downloads ? { downloads: r.downloads } : {}),
    ...(r.hearingImpaired ? { hearingImpaired: true } : {}),
  };
}

async function collectRows(
  vid: { imdb: string; season: number; episode: number },
  videoRelease: string,
  env: Env,
): Promise<Row[]> {
  const title = await resolveTitle(vid, videoRelease, env);
  const [os, pl, zl, sd] = await Promise.all([
    searchOpenSubs(vid.imdb, vid.season, vid.episode, 'sin').then(osRows).catch(() => []),
    searchPiratelk(vid.imdb, vid.season, vid.episode, videoRelease || title)
      .then((h) => plRows(h, videoRelease || title))
      .catch(() => []),
    title
      ? searchZoomlk(title, vid.imdb, vid.season, vid.episode)
          .then((h) => zlRows(h, videoRelease || title))
          .catch(() => [])
      : Promise.resolve([]),
    env.SUBDL_API_KEY
      ? searchSubdl(vid.imdb, vid.season, vid.episode, env.SUBDL_API_KEY).catch(() => [])
      : Promise.resolve([]),
  ]);

  const all = [...os, ...pl, ...zl, ...sd];
  if (all.length > 0) return rank(all, 'sin').slice(0, 20).map(toAddonRow);

  // No human Sinhala anywhere: offer one English reference row, translated on demand.
  const eng = await searchOpenSubs(vid.imdb, vid.season, vid.episode, 'eng').catch(() => []);
  if (eng.length && eng[0].url) {
    const best = eng[0];
    const token = encodeToken({ o: 'opensubsLegacy', u: best.url, l: 'eng', r: best.name });
    return [
      {
        id: `gemini:${best.id}`,
        name: `Sinhala (auto-translated) — ${best.name}`,
        lang: 'sin',
        url: `/download/${token}.srt`,
        origin: 'geminiTranslated',
        score: 0.15,
        human: false,
        downloads: best.downloads,
      },
    ];
  }
  return [];
}

/** Every row points at OUR /download route so extraction, caching and RAR routing always apply. */
function toAddonRow(r: ScoredRow): Row {
  const token = encodeToken({ o: r.origin, u: r.url, l: r.lang, r: r.name });
  return { ...r, url: `/download/${token}.srt` };
}

/** Release name from Stremio, else the Cinemeta title (cached in KV when available). */
async function resolveTitle(vid: { imdb: string; season: number }, videoRelease: string, env: Env): Promise<string> {
  const fromRelease = titleFromRelease(videoRelease);
  if (fromRelease.length >= 2) return fromRelease;
  const key = `title:${vid.imdb}`;
  const cached = await env.SUBS_INDEX?.get(key).catch(() => null);
  if (cached) return cached;
  const base = env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
  const kind = vid.season > 0 ? 'series' : 'movie';
  try {
    const r = await httpGet(`${base}/meta/${kind}/${vid.imdb}.json`, { 'User-Agent': BROWSER_UA }, 8000);
    if (r.status !== 200) return '';
    const name: string = JSON.parse(r.text)?.meta?.name ?? '';
    if (name) await env.SUBS_INDEX?.put(key, name, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
    return name;
  } catch {
    return '';
  }
}

const titleFromRelease = (r: string) =>
  (r || '').replace(/[._]/g, ' ').replace(/\s*\(?\d{4}\)?.*$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** GET /download/<token>.srt — fetch, extract, normalize, cache; 202 while translating. */
async function downloadRoute(token: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const payload = decodeToken(token) ?? (await legacyKvRow(env, token));
  if (!payload) return err(404, 'unknown token');

  const cacheKey = `${payload.u}|${payload.l}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached && cached.text.trim()) return new Response(cached.text, { status: 200, headers: okHeaders() });

  let sub: FetchedSub;
  try {
    const bytes = await fetchOrigin(payload);
    sub = await extract(bytes);
  } catch (e) {
    return new Response(`upstream failed: ${(e as Error)?.message ?? e}`, { status: 502, headers: pendingHeaders(60) });
  }

  // RAR/7z are never unpacked in-Worker; the nightly job pre-extracts them into R2.
  if (sub.note?.startsWith('rar:') || sub.note?.startsWith('7z:')) {
    const pre = await preindexGet(env, payload.u);
    if (pre && pre.trim()) return new Response(pre, { status: 200, headers: okHeaders() });
    return new Response('Packed archive (RAR/7z): pending nightly pre-index', { status: 202, headers: pendingHeaders(3600) });
  }

  let text: string;
  try {
    text = normalizeToSrt(sub);
  } catch (e) {
    return new Response(`bad subtitle: ${(e as Error)?.message ?? e}`, { status: 502, headers: pendingHeaders(60) });
  }
  if (!text.trim()) return new Response('no usable cues', { status: 502, headers: pendingHeaders(300) });

  if (payload.l !== 'sin') {
    // English reference file -> translate, then serve.
    const provider = env.TRANSLATOR_PROVIDER === 'google_v3' ? 'google' : 'gemini';
    const key = provider === 'google' ? env.GOOGLE_TRANSLATE_KEY : env.GEMINI_API_KEY;
    if (!key) return new Response('translator not configured', { status: 503, headers: pendingHeaders(3600) });

    const run = () =>
      provider === 'google'
        ? googleTranslate(key, text, { title: payload.r ?? 'movie' })
        : geminiTranslate(key, text, { title: payload.r ?? 'movie' });

    // With no KV/R2 there is nowhere to park the result, so a 202 could never
    // become a 200 — translate inline instead (network wait, not CPU).
    if (!env.SUBS_BUCKET && !env.SUBS_INDEX) {
      try {
        return new Response(await run(), { status: 200, headers: okHeaders() });
      } catch (e) {
        return new Response(`translation failed: ${(e as Error)?.message ?? e}`, { status: 502, headers: pendingHeaders(60) });
      }
    }

    if (!(await tryLock(env, token))) {
      return new Response('translation in progress', { status: 202, headers: pendingHeaders(10) });
    }
    const job = (async () => {
      try {
        const out = await run();
        await cachePut(env, cacheKey, { text: out, ext: 'srt' });
      } catch {
        /* the next poll re-runs the job */
      } finally {
        await unlock(env, token);
      }
    })();
    ctx.waitUntil(job);
    return new Response('translation started — poll again in ~10 s', { status: 202, headers: pendingHeaders(10) });
  }

  await cachePut(env, cacheKey, { text, ext: 'srt' });
  return new Response(text, { status: 200, headers: okHeaders() });
}

/** Archived tokens issued by the pre-1.1 build were stored in KV under `row:<sha1>`. */
async function legacyKvRow(env: Env, token: string): Promise<TokenPayload | null> {
  if (!env.SUBS_INDEX) return null;
  try {
    const raw = await env.SUBS_INDEX.get(`row:${token}`);
    if (!raw) return null;
    const r = JSON.parse(raw) as { origin?: string; url?: string; lang?: string; release?: string };
    if (!r?.url || !r?.origin) return null;
    return { o: r.origin, u: r.url, l: r.lang ?? 'sin', r: r.release };
  } catch {
    return null;
  }
}

async function fetchOrigin(p: TokenPayload): Promise<Uint8Array> {
  switch (p.o) {
    case 'piratelk':
      if (!plAllowed(p.u)) throw new Error('origin not allowed');
      return fetchPiratelk(p.u);
    case 'zoomlk':
      if (!zlAllowed(p.u)) throw new Error('origin not allowed');
      return fetchZoomlk(p.u);
    case 'opensubsLegacy':
    case 'opensubsSin':
      if (!osAllowed(p.u)) throw new Error('origin not allowed');
      return fetchOpenSubs(p.u);
    case 'subdl': {
      if (!sdAllowed(p.u)) throw new Error('origin not allowed');
      const r = await httpGet(p.u, { 'User-Agent': BROWSER_UA }, 20000);
      if (r.status !== 200) throw new Error(`subdl ${r.status}`);
      return r.bytes;
    }
    default:
      throw new Error(`unknown origin ${p.o}`);
  }
}

function normalizeToSrt(sub: FetchedSub): string {
  const text = sub.text.replace(/^\uFEFF/, '');
  let cues = parseTimed(text, sub.ext);
  cues = stripWatermarks(cues);
  cues = repairCues(cues);
  return emitSrt(cues);
}

async function health(): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const probe = (url: string, ua = BROWSER_UA) =>
    fetch(url, { method: 'GET', headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(8000) })
      .then((r) => r.status)
      .catch(() => 0);
  const [os, pl, zl] = await Promise.all([
    probe('https://rest.opensubtitles.org/search/sublanguageid-sin', 'TemporaryUserAgent'),
    probe('https://piratelk.com/wp-json/wp/v2/posts?per_page=1'),
    probe('https://zoom.lk/robots.txt'),
  ]);
  return {
    ok: true,
    version: ADDON_VERSION,
    ms: Date.now() - t0,
    sources: { opensubtitles: os, piratelk: pl, 'zoom.lk': zl },
    time: new Date().toISOString(),
  };
}
