/**
 * token.ts — self-describing, stateless download tokens.
 *
 * The original code stored `row:<sha1>` in KV and looked it up in
 * /download/<sha1>. That made KV **mandatory**: with no KV binding every
 * row 404'd. Tokens now carry the row itself:
 *
 *     v1<base64url({"o":origin,"u":url,"l":lang,"r":release})>
 *
 * so the addon works with no KV at all (KV/R2 are pure cache). Because the
 * payload is attacker-readable *and* attacker-writable, the origin URL is
 * re-validated against a per-source host allowlist before any fetch
 * (see isAllowedUrl), which is what stops a tampered token becoming SSRF.
 */
export interface TokenPayload {
  /** origin adapter: piratelk | zoomlk | opensubsLegacy | opensubsSin | subdl */
  o: string;
  /** upstream subtitle URL (or zoom.lk /sub-download id URL) */
  u: string;
  /** language of the upstream file: "sin" (human) or "eng" (needs translating) */
  l: string;
  /** release/file name, used in prompts and labels */
  r?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const TOKEN_PREFIX = 'v1';
/** /download/<token>.srt accepts this charset; see the route regex. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{8,1200}$/;
/** Release names are only a label/prompt hint — never let them bloat the URL. */
const MAX_RELEASE = 60;

export function b64urlEncode(input: string): string {
  const bytes = encoder.encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(input: string): string | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function encodeToken(p: TokenPayload): string {
  const payload: TokenPayload = {
    o: String(p.o).slice(0, 24),
    u: String(p.u).slice(0, 700),
    l: String(p.l).slice(0, 8),
    r: p.r ? String(p.r).slice(0, MAX_RELEASE) : undefined,
  };
  return TOKEN_PREFIX + b64urlEncode(JSON.stringify(payload));
}

export function decodeToken(token: string): TokenPayload | null {
  if (!TOKEN_RE.test(token) || !token.startsWith(TOKEN_PREFIX)) return null;
  const raw = b64urlDecode(token.slice(TOKEN_PREFIX.length));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.o !== 'string' || typeof p.u !== 'string' || typeof p.l !== 'string') return null;
  if (!p.o || !p.u) return null;
  return { o: p.o, u: p.u, l: p.l, r: typeof p.r === 'string' ? p.r : undefined };
}
