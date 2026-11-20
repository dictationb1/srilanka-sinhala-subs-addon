/**
 * cache.ts — R2 permanent cache with a KV-only fallback. Both are OPTIONAL:
 * with no binding every function degrades to "not cached" instead of throwing.
 *
 * Audit fix: the nightly pre-indexer writes literal `preindex:<url>` objects to
 * R2, but the Worker looked them up through `cacheGet`, which SHA-1s the string
 * into `sub:<hash>` — the two could never match, so pre-indexed RAR output was
 * unreachable. `preindexGet` reads the literal key the Python job writes.
 */
import type { Env } from './env.ts';
import type { FetchedSub } from './normalize.ts';

export type { Env };

export async function sha1hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cacheGet(env: Env, url: string): Promise<FetchedSub | null> {
  if (env.SUBS_BUCKET) {
    try {
      const o = await env.SUBS_BUCKET.get(await keyForUrl(url));
      if (!o) return null;
      const ext = ((o as R2ObjectBody & { customMetadata?: Record<string, string> }).customMetadata?.ext ?? 'srt') as FetchedSub['ext'];
      return { text: await o.text(), ext };
    } catch {
      return null;
    }
  }
  if (!env.SUBS_INDEX) return null;
  try {
    return await env.SUBS_INDEX.get<FetchedSub>(await keyForUrl(url), 'json');
  } catch {
    return null;
  }
}

export async function cachePut(env: Env, url: string, sub: FetchedSub): Promise<void> {
  if (!sub.text || sub.text.trim() === '') return; // never cache a routing note as a subtitle
  const key = await keyForUrl(url);
  if (env.SUBS_BUCKET) {
    try {
      await env.SUBS_BUCKET.put(key, sub.text, { customMetadata: { ext: sub.ext } } as R2PutOptions);
    } catch {
      /* cache is best-effort */
    }
    return;
  }
  if (!env.SUBS_INDEX) return;
  // KV free tier: 1k writes/day — keep entries bounded and expiring.
  await env.SUBS_INDEX.put(key, JSON.stringify(sub), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
}

/** Read the literal `preindex:<url>` key the nightly Python pre-indexer writes. */
export async function preindexGet(env: Env, url: string): Promise<string | null> {
  const key = `preindex:${url}`;
  if (env.SUBS_BUCKET) {
    try {
      const o = await env.SUBS_BUCKET.get(key);
      if (o) return await o.text();
    } catch {
      /* fall through to KV */
    }
  }
  if (env.SUBS_INDEX) {
    try {
      return await env.SUBS_INDEX.get(key);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Lock held while a translation job runs so retries do not double-spend.
 * With no KV there is no cross-request lock; translation still proceeds
 * (a duplicate job is wasteful but never breaks the response).
 */
export async function tryLock(env: Env, token: string, ttlSeconds = 600): Promise<boolean> {
  if (!env.SUBS_INDEX) return true;
  // KV keys are capped at 512 bytes; tokens can be longer, so hash them.
  const key = `lock:${(await sha1hex(token)).slice(0, 32)}`;
  try {
    const existing = await env.SUBS_INDEX.get(key);
    if (existing) return false;
    await env.SUBS_INDEX.put(key, String(Date.now()), { expirationTtl: ttlSeconds });
    return true;
  } catch {
    return true; // KV hiccup must not block translation
  }
}

export async function unlock(env: Env, token: string): Promise<void> {
  if (!env.SUBS_INDEX) return;
  await env.SUBS_INDEX.delete(`lock:${(await sha1hex(token)).slice(0, 32)}`).catch(() => {});
}

export const keyForUrl = (url: string) => sha1hex('anant-sin:' + url).then((h) => `sub:${h}`);
