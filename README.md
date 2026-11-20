# Sri Lanka Sinhala Subtitles — Stremio Addon for Cloudflare Workers

**සිංහල උපසිරැසි ඇඩෝනය** — piratelk.com, zoom.lk සහ OpenSubtitles එකට එකතු කර, සිංහල උපසිරැසි නොමැති විට ඉංග්‍රීසි උපසිරැසි Google Gemini මගින් ස්වාභාවික කථා කරන සිංහලට පරිවර්තනය කරයි.

A zero-cost Cloudflare Worker that serves Sinhala subtitles over the Stremio addon protocol. Pure TypeScript — **no Python, Rust or `unrar` inside the Worker**: unpacking is `fflate` (pure JS), and RAR/7z archives are pre-extracted nightly by GitHub Actions into R2. Works with standard Stremio clients **and** AnantPlay's forks.

| | |
| --- | --- |
| Routes | `/manifest.json`, `/subtitles/:type/:id.json`, `/download/:token.srt`, `/health` |
| Language contract | every row carries `"lang": "sin"` (AnantPlay compares with `equals`) |
| Setup required | none — KV and R2 are optional caches |
| Cost | Cloudflare Workers free tier + Google AI Studio free key |

---

## 5-minute deployment (English)

### 1 · Worker

```bash
git clone https://github.com/dictationb1/srilanka-sinhala-subs-addon.git
cd srilanka-sinhala-subs-addon
npm ci
npm install -g wrangler@latest
wrangler login
```

### 2 · Free Gemini key (**no credit card**)

1. Open <https://aistudio.google.com/apikey> → **Create API key**.
2. Store it as a Worker secret:

```bash
wrangler secret put GEMINI_API_KEY     # paste the key
```

### 3 · Deploy

```bash
wrangler deploy
```

No KV, no R2, no other secret is needed to start serving. Verify:

```bash
curl -s https://<your-worker>.workers.dev/manifest.json
curl -s "https://<your-worker>.workers.dev/subtitles/movie/tt0468569.json?videoRelease=The%20Dark%20Knight%202008"
curl -s https://<your-worker>.workers.dev/health
```

### 4 · Install

Open Stremio → **Addons → Install from URL** → `https://<your-worker>.workers.dev/manifest.json`.
For AnantPlay, add the same URL as your subtitle source.

### 5 · Optional: caching, locks and RAR support

Both bindings are commented out in `wrangler.toml` by default, so deployment never depends on them.

```bash
wrangler kv namespace create SUBS_INDEX   # paste the id into wrangler.toml, uncomment [[kv_namespaces]]
wrangler r2 bucket create subs-bucket     # uncomment [[r2_buckets]]
```

* **KV only** — download cache, one-shot translation lock, Cinemeta title cache.
* **R2** — permanent subtitle cache and the nightly pre-indexer's RAR/7z output.
* **Neither** — translation runs **inline** (a single request may take ~10 s) because there is nowhere to park a background result; RAR/7z archives answer `202` until pre-indexed.

---

## 5-විනාඩි ස්ථාපනය (සිංහල)

1. **Worker සකසන්න** — `git clone` කර `npm ci`, ඉන්පසු `wrangler login`.
2. **නොමිලේ Gemini key** — <https://aistudio.google.com/apikey> වෙතින් key එකක් සාදා `wrangler secret put GEMINI_API_KEY` ලෙස ඇතුළත් කරන්න. ක්‍රෙඩිට් කාඩ්පතක් අවශ්‍ය නැත.
3. **Deploy** — `wrangler deploy`. KV හෝ R2 නොමැතිවත් වැඩ කරයි.
4. **ස්ථාපනය** — Stremio → Addons → Install from URL → `https://<your-worker>.workers.dev/manifest.json`. AnantPlay සඳහා එම URL එකම subtitle source ලෙස එකතු කරන්න.
5. **අමතර (අවශ්‍ය නැත)** — `wrangler kv namespace create SUBS_INDEX` සහ `wrangler r2 bucket create subs-bucket` සිදු කර `wrangler.toml` තුළ ඒවා uncomment කරන්න. එවිට cache, translation lock සහ RAR pre-index ප්‍රතිඵල භාවිත කළ හැක.

> පරිවර්තනය සඳහා `GEMINI_API_KEY` අවශ්‍ය වන්නේ සිංහල උපසිරැසි **නොමැති** විට පමණි. එය නොමැති නම් ඇඩෝනය `503` ලෙස පිළිතුරු දෙන අතර, සිංහල උපසිරැසි සාමාන්‍ය ලෙස සේවය කරයි.

---

## Architecture

| Layer | Where it runs | Notes |
| --- | --- | --- |
| Search | Worker: OpenSubtitles legacy REST (`sin`), piratelk WP-JSON, zoom.lk `?s=` | 3–4 subrequests |
| Title lookup | Cinemeta `meta/{movie,series}/<id>.json` when Stremio sends no `videoRelease` | cached in KV if present |
| Extraction | `fflate` zip/gzip, nested-folder aware, UTF-16LE/BE + windows-1252 decode, ASS/SSA/VTT → SRT | ~1 ms per 100 KB |
| RAR / 7z | **never** in the Worker — GitHub Actions `scripts/preindex.py` → R2 `preindex:<url>` | Worker reads that literal key |
| Translation | Gemini 2.5 Flash, **≤6 requests per movie**, strict JSON + cue-count validation, retry-then-split | ~8–15 s |
| Sync | pure-TS cue-start cross-correlation (offset + 23.976↔25 fps) | <3 ms for 1500 cues |
| Cache | R2 (`sub:<sha1>`) → KV fallback → none | optional |

### The `si` ↔ `sin` contract

AnantPlay filters Stremio rows with an exact `osCode(s.lang).equals(code)` comparison, and Android's ISO-3 code for Sinhala is `sin`. Every row this addon emits is normalized to `"sin"` (aliases `si`, `si-LK`, `si_lk`, `sinh` are accepted on input). A `"si"` row would be **silently dropped**, so `toSin()` is applied at the row boundary and covered by tests.

### Absolute URLs (why rows are not relative)

`Subs.find()` hands `url` straight to `HttpURLConnection`. A relative `/download/...` throws, the sample fallback returns nothing, and the addon appears empty. Rows are therefore emitted as absolute URLs (`https://<worker>/download/<token>.srt`), and every row — human Sinhala included — goes through our own extractor and cache.

### Tokens instead of KV rows

`/download/<token>.srt` tokens are self-describing: `v1` + base64url of `{origin, url, lang, release}`. That is what makes KV optional. Because a token is user-writable, every fetch is re-checked against a per-source host allowlist (`piratelk.com`, `zoom.lk/sub-download/<digits>`, `*.opensubtitles.org`, `dl.subdl.com`) — a tampered token can never become SSRF.

### 202 protocol

`GET /download/<token>.srt` answers `202` + `Retry-After: 10` + `Cache-Control: no-store` while a Gemini job runs in `ctx.waitUntil`; the body deliberately contains no `-->`, so `SubFetch` rejects it as "not a subtitle" and the client retries. Standard Stremio clients poll until `200`. With no KV/R2 bound the Worker translates inline and returns `200` immediately — a `202` is never emitted where it could not later be resolved.

---

## Sources & robots.txt

| Site | Status | Method | robots.txt |
| --- | --- | --- | --- |
| piratelk.com | ✅ | WP-JSON `/wp-json/wp/v2/posts?search=` + `/download/<slug>/` zip | fully open |
| zoom.lk | ✅ | `?s=` search + `/sub-download/<id>` | only `/dlm_uploads/` disallowed — **never touched** |
| OpenSubtitles | ✅ | legacy REST `sublanguageid-sin`, `TemporaryUserAgent` | API by design |
| sinhalasub.lk | ❌ v1 | login-gated interstitials | not scraped |
| SubDL | ⏸ optional | needs `SUBDL_API_KEY`, limits unverified | off by default |

The pre-indexer additionally refuses `baiscope.lk` and `cineru.lk` outright, honours the `*` group of `robots.txt`, and sleeps 1 s between requests.

---

## Tests

```bash
npm ci
npm run typecheck                    # strict tsc, Worker + tests, zero errors
node --test tests/test_worker.ts     # 40/40 PASS
python3 -m pip install -r tests/requirements.txt
python3 -m pytest tests/test_srt_tools.py -q   # 17/17 PASS
python3 scripts/preindex.py --selftest         # offline SigV4 / key / robots check
npx wrangler deploy --dry-run --outdir dist    # bundle proof (~54 KiB)
```

TypeScript tests mock `fetch`, so the suite is deterministic and needs no network or API key. They cover: nested-zip extraction, traversal/`__MACOSX` rejection, RAR/7z routing, UTF-16 and windows-1252 decoding, ASS parsing, the `"Credit card"` watermark regression, timestamp repair invariants, `si`→`sin`, token round-trip, SSRF allowlists, aligner degeneracy, ≤6-request batching, end-to-end translation, absolute row URLs, `202`→`200` polling, and the no-KV inline path.

### Fixtures are synthetic (DMCA)

`tests/fixtures/` contains **only generated placeholder data** (`scripts/make_fixtures.py`): invented Sinhala dialogue, 2.7 KB total. The two original fixtures — full copyrighted subtitles for *The Dark Knight* (2008) and *Elumale* (2025) — were removed from the repository. CI fails if any archive outside `tests/fixtures/` is tracked, or if a fixture exceeds 8 KB.

---

## Nightly pre-indexer (optional, RAR/7z only)

Add repository secrets (Settings → Secrets → Actions):

* `CLOUDFLARE_API_TOKEN` — enables deployment from `main` (deploy is skipped, not failed, without it).
* `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` — let `scripts/preindex.py` upload with a stdlib SigV4 `PUT` to `preindex:<subtitle-url>`.
* Without R2 credentials the nightly job runs as a dry run instead of failing.

The Worker and the Python job share one key format (`preindex:<url>`); a regression test asserts it.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No rows in Stremio | Check `/health` and the `/subtitles/...json` response; without `videoRelease` the title comes from Cinemeta, which some networks block. |
| `503 translator not configured` | No English reference file existed and `GEMINI_API_KEY` is unset. Set the secret. |
| `202` never becomes `200` | KV or R2 must be bound for background translation. Without them the Worker translates inline instead. |
| RAR always `202` | Run the nightly pre-indexer (or the manual `workflow_dispatch`), and bind R2. |
| Deploy skipped in CI | `CLOUDFLARE_API_TOKEN` is not set — intentional, not a failure. |

## License

MIT. Vendored `fflate` keeps its own MIT license (`vendor/LICENSE-fflate.txt`). Scrapers stay on robots-allowed routes, cache aggressively and never touch disallowed paths — please keep them that way if you fork this.
