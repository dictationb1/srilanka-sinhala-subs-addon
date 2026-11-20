/**
 * http.ts — thin fetch wrapper usable in BOTH runtimes with ZERO Node imports.
 *
 * Gate 2 audit: the original file imported `node:child_process`, `node:util`
 * and used `Buffer` from inside `src/` and only compiled because
 * `nodejs_compat` was enabled — that is a Node dependency leaking into the
 * Worker bundle. Node-only fallbacks are now injected by the caller instead
 * (see registerHttpFallback), so `src/` is 100% Worker-safe and the bundle no
 * longer needs nodejs_compat at all.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface HttpResult {
  status: number;
  bytes: Uint8Array;
  text: string;
}

export type HttpFallback = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<HttpResult>;

let fallback: HttpFallback | null = null;

/**
 * Register a runtime-specific escape hatch (used by Node tooling/tests when a
 * site rejects Node's TLS fingerprint). The Worker never registers one, so no
 * Node API is ever referenced from the bundle.
 */
export function registerHttpFallback(fn: HttpFallback | null): void {
  fallback = fn;
}

/** Hard cap on a single response body (Worker memory is 128 MB; subtitles are <5 MB). */
export const MAX_HTTP_BYTES = 8 * 1024 * 1024;

export async function httpGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15000,
): Promise<HttpResult> {
  let result: HttpResult;
  try {
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_HTTP_BYTES) throw new Error(`response too large: ${ab.byteLength} bytes`);
    result = { status: res.status, bytes: new Uint8Array(ab), text: new TextDecoder().decode(ab) };
  } catch (e) {
    if (!fallback) throw e;
    return fallback(url, headers, timeoutMs);
  }
  // Cloudflare-fronted sites may block non-browser TLS fingerprints (Node only);
  // the Workers runtime uses its own stack and does not hit this.
  const blocked = result.status === 403 || result.status === 429 || (result.status === 503 && result.text.includes('Just a moment'));
  if (blocked && fallback) return fallback(url, headers, timeoutMs);
  return result;
}
