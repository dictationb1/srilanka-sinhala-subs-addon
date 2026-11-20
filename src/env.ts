/**
 * env.ts — the single source of truth for Worker bindings.
 *
 * Every binding is optional on purpose: the addon must run with **zero**
 * setup (no KV, no R2, no secrets) and still serve Sinhala rows, because
 * subtitle rows are carried in self-describing tokens (see token.ts) and
 * caching simply degrades to "not cached".
 */
export interface Env {
  /** Optional KV: download cache fallback, translation lock, title cache. */
  SUBS_INDEX?: KVNamespace;
  /** Optional R2: permanent cache + nightly pre-indexed RAR/7z output. */
  SUBS_BUCKET?: R2Bucket;
  /** Google AI Studio key (free tier) — primary translator. */
  GEMINI_API_KEY?: string;
  /** Google Cloud Translation v3 key — optional fallback provider. */
  GOOGLE_TRANSLATE_KEY?: string;
  /** Optional SubDL key (off by default, limits unverified). */
  SUBDL_API_KEY?: string;
  /** "gemini" (default) | "google_v3". */
  TRANSLATOR_PROVIDER?: string;
  /** Test hook: override the Cinemeta metadata origin. */
  CINEMETA_BASE?: string;
}
