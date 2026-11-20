/**
 * test_worker.ts — node:test suite (no network, no API keys).
 * Run: node --test tests/test_worker.ts
 *
 * Fixtures are SYNTHETIC (scripts/make_fixtures.py): placeholder Sinhala dialogue,
 * never a copyrighted subtitle file. Network is mocked per test through
 * globalThis.fetch, so the suite is deterministic on CI.
 */
import { test } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { gzipSync, unzipSync } from '../vendor/fflate.esm.js';
import {
  pickZipEntry,
  kind,
  extract,
  isWatermark,
  stripWatermarks,
  repairCues,
  wrap,
  decode,
} from '../src/normalize.ts';
import { parseSrt, parseAss, parseTimed, emitSrt, stripMarkup, tc } from '../src/srt.ts';
import { toSin, releaseScore, parseVideoId, rank, type ScoredRow } from '../src/match.ts';
import { bestLinearFit, applyAlign, median } from '../src/sync.ts';
import { parseAnswer, buildPrompt, planBatches, translateSrt, translateCues, MAX_TOTAL_REQUESTS } from '../src/translate/geminiFlash.ts';
import { encodeToken, decodeToken, TOKEN_RE } from '../src/token.ts';
import { isAllowedUrl as plAllowed, searchPiratelk } from '../src/sources/piratelk.ts';
import { isAllowedUrl as zlAllowed, searchZoomlk } from '../src/sources/zoomlk.ts';
import { isAllowedUrl as osAllowed } from '../src/sources/opensubsLegacy.ts';
import { isAllowedUrl as sdAllowed, absolutize } from '../src/sources/subdl.ts';
import worker, { manifest } from '../src/index.ts';
import type { Env } from '../src/env.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const NESTED_ZIP = fixture('synthetic-nested.zip');
const FLAT_ZIP = fixture('synthetic-flat.zip');
const RAR4 = fixture('synthetic-rar4.rar');

const SINHALA = /[\u0D80-\u0DFF]/;

// ---------------------------------------------------------------- helpers

async function withFetch(routes: Array<[string, () => Response]>, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as Request).url);
    for (const [needle, make] of routes) if (url.includes(needle)) return make();
    return new Response('not mocked: ' + url, { status: 404 });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function memKV(init: Record<string, string> = {}): KVNamespace {
  const map = new Map(Object.entries(init));
  return {
    get: async (key: string, opts?: unknown) => {
      const v = map.get(key);
      if (v === undefined) return null;
      return opts === 'json' ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => void map.set(key, value),
    delete: async (key: string) => void map.delete(key),
  } as unknown as KVNamespace;
}

function devCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { pending, ctx };
}

const SRT_3 =
  '1\n00:00:01,000 --> 00:00:02,500\nHello there.\n\n' +
  '2\n00:00:03,000 --> 00:00:04,500\nWhere are you?\n\n' +
  '3\n00:00:05,000 --> 00:00:06,500\nSee you tomorrow.\n';

const GZIP_SRT = gzipSync(new TextEncoder().encode(SRT_3));
const OS_URL = 'https://dl.opensubtitles.org/en/download/sub/9990001.gz';

// ---------------------------------------------------------------- normalizer

test('magic detection: zip / gzip / rar4 / 7z / raw', () => {
  assert.equal(kind(NESTED_ZIP), 'zip');
  assert.equal(kind(GZIP_SRT), 'gzip');
  assert.equal(kind(RAR4), 'rar4');
  assert.equal(kind(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])), 'rar5');
  assert.equal(kind(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])), '7z');
  assert.equal(kind(new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nhi\n')), 'raw');
});

test('nested-folder zip: subtitle found at any depth (piratelk layout)', () => {
  const names = Object.keys(unzipSync(NESTED_ZIP));
  const pick = pickZipEntry(names);
  assert.ok(pick, 'srt inside the nested folder must be found');
  assert.equal(pick!.ext, 'srt');
  assert.ok(pick!.name.includes('Piratelk.com/'), pick!.name);
});

test('nested-folder zip extracts Sinhala cues (UTF-8 BOM)', async () => {
  const sub = await extract(NESTED_ZIP);
  assert.equal(sub.ext, 'srt');
  const cues = parseSrt(sub.text);
  assert.ok(cues.length >= 10, `${cues.length} cues`);
  assert.ok(cues.filter((c) => SINHALA.test(c.text)).length >= 10, 'Sinhala text survived');
});

test('flat zip extracts Sinhala cues (zoom.lk layout)', async () => {
  const sub = await extract(FLAT_ZIP);
  assert.equal(sub.ext, 'srt');
  const cues = parseSrt(sub.text);
  assert.ok(cues.length >= 12, `${cues.length} cues`);
  assert.ok(cues.filter((c) => SINHALA.test(c.text)).length >= 12);
});

test('traversal / __MACOSX / dotfiles are never picked', () => {
  assert.equal(pickZipEntry(['__MACOSX/x/a.srt', '._x.srt', '../evil.srt', '/abs.srt', 'movie.srt'])?.name, 'movie.srt');
  assert.equal(pickZipEntry(['__MACOSX/dir/a.srt', 'b/c.srt'])?.name, 'b/c.srt');
  assert.equal(pickZipEntry(['a\\b.srt']), null);
  assert.equal(pickZipEntry(['readme.txt']), null);
  // rank: .srt beats .ass/.vtt at any depth
  assert.equal(pickZipEntry(['deep/dir/b.ass', 'x.srt'])?.ext, 'srt');
});

test('RAR and 7z are routed to the pre-indexer, never unpacked in-Worker', async () => {
  const rar = await extract(RAR4);
  assert.equal(rar.note, 'rar:rar4');
  assert.equal(rar.text, '');
  const sevenZip = await extract(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]));
  assert.equal(sevenZip.note, '7z:route-to-preindexer');
});

test('decode: UTF-16LE, UTF-16BE, UTF-8 BOM and windows-1252 fallback', () => {
  assert.equal(decode(new Uint8Array([0xff, 0xfe, 0x31, 0x00])), '1');
  assert.equal(decode(new Uint8Array([0xfe, 0xff, 0x00, 0x31])), '1');
  assert.equal(decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
  // 0x93/0x94 are smart quotes in cp1252 and invalid UTF-8 -> must not throw
  assert.equal(decode(new Uint8Array([0x93, 0x68, 0x69, 0x94])), '“hi”');
});

test('watermark filter: "Credit card" dialogue survives, credits/sites are stripped', () => {
  assert.equal(isWatermark('Credit card', 0, 40), false, 'real dialogue must never be stripped');
  assert.equal(isWatermark('Credit card?', 0, 40), false);
  assert.equal(isWatermark('Credits by John', 0, 40), true);
  assert.equal(isWatermark('Subtitles by John', 0, 40), true);
  assert.equal(isWatermark('Synced by Kasun', 39, 40), true);
  assert.equal(isWatermark('www.zoom.lk sync by Kasun', 20, 40), true);
  assert.equal(isWatermark('I need the credit card.', 20, 40), false);
  assert.equal(isWatermark('A very long line '.repeat(20), 0, 40), false);
  const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nSubtitles by X\n\n2\n00:00:03,000 --> 00:00:04,000\nReal line.\n');
  assert.equal(stripWatermarks(cues).length, 1);
});

test('timestamp repair: reversed, too short, overlap — never end <= start', () => {
  const fixed = repairCues([
    { start: 2000, end: 1000, text: 'reversed' },
    { start: 3000, end: 3100, text: 'short' },
    { start: 3300, end: 9000, text: 'overlap' },
    { start: 15000, end: 16000, text: 'clean' },
    { start: Number.NaN, end: 5, text: 'nan' },
  ]);
  assert.equal(fixed.length, 4, 'NaN cue dropped');
  assert.equal(fixed[0].end - fixed[0].start, 500);
  assert.ok(fixed[1].end - fixed[1].start >= 500);
  assert.ok(fixed[2].start >= fixed[1].end);
  assert.equal(fixed[3].start, 15000);
  for (const c of fixed) assert.ok(c.end > c.start, 'invalid cue emitted');
});

// ---------------------------------------------------------------- srt

test('ASS/SSA subtitles are parsed (they used to yield zero cues)', () => {
  const ass = [
    '[Script Info]',
    'Title: Synthetic',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\an8}ආයුබෝවන්\\Nලෝකය, හරි',
    'Dialogue: 0,0:00:04.00,0:00:05.25,Default,,0,0,0,,දෙවැනි පේළිය',
  ].join('\n');
  const cues = parseAss(ass);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1500);
  assert.equal(cues[0].end, 3000);
  assert.equal(cues[0].text, 'ආයුබෝවන්\nලෝකය, හරි', 'commas + \\N preserved');
  assert.equal(parseTimed(ass, 'ass').length, 2);
});

test('VTT -> SRT timing conversion', () => {
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.500\nHello\n';
  const cues = parseTimed(vtt, 'vtt');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 1000);
  assert.equal(tc(cues[0].end), '00:00:03,500');
});

test('parse/emit roundtrip, markup strip, timecode', () => {
  const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHello\nworld\n');
  assert.equal(cues[0].text, 'Hello\nworld');
  assert.ok(emitSrt(cues).includes('00:00:01,000 --> 00:00:02,500'));
  assert.equal(stripMarkup('{\\an8}<font color="red">hi</font>'), 'hi');
  assert.equal(tc(61500), '00:01:01,500');
  assert.equal(parseSrt(emitSrt(cues))[0].start, 1000);
});

test('Sinhala-safe wrap never exceeds the width budget', () => {
  const w = wrap('මෙය ඉතා දිග සිංහල එක්සතැනක ඇති දිග පේළියක් වන අතර එය එසැසැස්මට වඩා දිගු ය', 40);
  assert.ok(w.includes('\n'));
  for (const line of w.split('\n')) assert.ok(line.length <= 45, String(line.length));
});

// ---------------------------------------------------------------- matching / language

test('release scorer: case-insensitive jaccard + group bonus + year penalty', () => {
  assert.ok(releaseScore('INCEPTION.1080P.BluRay.X264-NTb', 'inception.1080p.bluray.x264-ntb') > 0.9);
  assert.equal(releaseScore('', 'x'), 0);
  const hi = releaseScore('Movie 2026 1080p webrip x264-FLUX', 'movie 2026 1080p webrip x264-FLUX');
  const lo = releaseScore('Movie 2025 1080p webrip x264-FLUX', 'movie 2026 1080p webrip x264-FLUX');
  assert.ok(hi > lo, 'year mismatch halves the score');
});

test('si/sin: every alias normalizes to "sin" (AnantPlay equals() contract)', () => {
  for (const alias of ['si', 'sin', 'SIN', 'si-LK', 'si_lk', 'sinh']) assert.equal(toSin(alias), 'sin', alias);
  assert.equal(toSin('eng'), 'eng');
  const rows = rank([
    { id: 'a', name: 'x', lang: 'si', url: 'u1', origin: 'piratelk', score: 1, human: true },
    { id: 'b', name: 'y', lang: 'sin', url: 'u1', origin: 'zoomlk', score: 0.5, human: true },
    { id: 'c', name: 'z', lang: 'eng', url: 'u2', origin: 'opensubsSin', score: 1, human: true },
  ]);
  assert.equal(rows.length, 1, 'duplicate URL collapsed, non-Sinhala dropped');
  assert.equal(rows[0].lang, 'sin');
});

test('parseVideoId: movie, series, junk', () => {
  assert.deepEqual(parseVideoId('movie', 'tt0468569'), { imdb: 'tt0468569', season: 0, episode: 0 });
  assert.deepEqual(parseVideoId('series', 'tt0944947:1:2'), { imdb: 'tt0944947', season: 1, episode: 2 });
  assert.equal(parseVideoId('movie', 'xyz'), null);
  assert.equal(parseVideoId('movie', 'tt123'), null, 'short id rejected');
});

// ---------------------------------------------------------------- tokens & allowlists

test('token: roundtrip, garbage rejected, release truncated', () => {
  const token = encodeToken({ o: 'piratelk', u: 'https://piratelk.com/download/x/', l: 'sin', r: 'X'.repeat(200) });
  assert.match(token, TOKEN_RE);
  const back = decodeToken(token)!;
  assert.equal(back.o, 'piratelk');
  assert.equal(back.u, 'https://piratelk.com/download/x/');
  assert.equal(back.r!.length, 60);
  assert.equal(decodeToken('v1!!!!'), null);
  assert.equal(decodeToken('v1' + btoa('not json')), null);
  assert.equal(decodeToken(''), null);
});

test('allowlists block SSRF through a tampered token', () => {
  assert.equal(plAllowed('https://piratelk.com/download/a/'), true);
  assert.equal(plAllowed('http://piratelk.com/download/a/'), false, 'https only');
  assert.equal(plAllowed('https://evil.example/download/a/'), false);
  assert.equal(plAllowed('https://piratelk.com.evil.example/x'), false);
  assert.equal(plAllowed('https://piratelk.com/wp-admin/admin-ajax.php'), false, 'only /download/ paths');
  assert.equal(zlAllowed('https://zoom.lk/sub-download/23752'), true);
  assert.equal(zlAllowed('https://zoom.lk/dlm_uploads/x.zip'), false, 'robots-disallowed path never fetched');
  assert.equal(zlAllowed('https://evil.example/sub-download/1'), false);
  assert.equal(osAllowed('https://dl.opensubtitles.org/en/download/sub/1.gz'), true);
  assert.equal(osAllowed('https://opensubtitles.org.evil.example/x'), false);
  assert.equal(sdAllowed('https://dl.subdl.com/subtitle/1.zip'), true);
  assert.equal(sdAllowed('https://evil.example/1.zip'), false);
  assert.equal(absolutize('/subtitle/abc.zip'), 'https://dl.subdl.com/subtitle/abc.zip');
  assert.equal(absolutize('https://evil.example/x'), '');
});

// ---------------------------------------------------------------- sync

test('aligner: constant offset on synthetic timelines', () => {
  // Sub-second jitter so the grid is not perfectly uniform (a uniform grid makes
  // any multiple of the cue spacing an equally good alignment — real subtitles
  // are never uniform).
  const ref = Array.from({ length: 60 }, (_, i) => 1000 + i * 2000 + ((i * 137) % 300));
  const shifted = ref.map((t) => t + 800);
  const fit = bestLinearFit(ref, shifted);
  assert.ok(Math.abs(fit.offsetMs + 800) < 80, `offset ${fit.offsetMs}`);
  assert.ok(fit.score > 0.8, `score ${fit.score}`);
  const applied = applyAlign([{ start: 4000, end: 5000, text: 'x' }], fit.offsetMs);
  assert.ok(Math.abs(applied[0].start - 3200) < 80, `aligned ${applied[0].start}`);
});

test('aligner: degenerate input never yields NaN', () => {
  assert.deepEqual(bestLinearFit([], []), { offsetMs: 0, score: 0 });
  assert.equal(bestLinearFit([1, 2, 3], [1, 2, 3]).score, 0);
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  const out = applyAlign([{ start: 100, end: 200, text: 'x' }], Number.NaN);
  assert.equal(out[0].start, 100);
  const same = Array.from({ length: 20 }, (_, i) => i * 1000);
  const fit = bestLinearFit(same, same);
  assert.ok(Number.isFinite(fit.offsetMs), 'zero offsets must not become NaN');
});

test('aligner speed: 1500 cues well under the Worker CPU budget', () => {
  const ref = Array.from({ length: 1500 }, (_, i) => 1000 + i * 2500 + (i % 7) * 30);
  const tgt = ref.map((t) => t + 1200);
  const t0 = performance.now();
  bestLinearFit(ref, tgt);
  const ms = performance.now() - t0;
  assert.ok(ms < 60, `took ${ms.toFixed(2)} ms`);
});

// ---------------------------------------------------------------- translator

test('batcher: never more than 6 Gemini subrequests per movie', () => {
  assert.equal(planBatches(1500).length, 5);
  assert.equal(planBatches(3000).length, 6);
  assert.equal(planBatches(10_000).length, 6);
  assert.equal(planBatches(0).length, 0);
  const flat = planBatches(1234).flat();
  assert.deepEqual(flat, Array.from({ length: 1234 }, (_, i) => i));
});

test('subrequest budget: retries + splits can never exceed MAX_TOTAL_REQUESTS', async () => {
  let calls = 0;
  const cues = Array.from({ length: 2000 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 900, text: `line ${i}` }));
  await withFetch(
    [
      [
        'generativelanguage.googleapis.com',
        () => {
          calls++;
          // always malformed -> forces the retry + split path
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), { status: 200 });
        },
      ],
    ],
    async () => {
      await assert.rejects(() => translateCues('k', cues, { title: 'Budget' }));
    },
  );
  assert.ok(calls <= MAX_TOTAL_REQUESTS, `made ${calls} requests, budget ${MAX_TOTAL_REQUESTS}`);
  assert.equal(planBatches(cues.length).length, 6);
});

test('answer validator: complete, incomplete, non-JSON', () => {
  assert.equal(parseAnswer('{"1":"a","2":"b","3":"c","4":"d"}', 4).size, 4);
  assert.equal(parseAnswer('```json\n{"1":"a","2":"b"}\n```', 2).size, 2);
  assert.throws(() => parseAnswer('{"1":"a","2":"b"}', 4));
  assert.throws(() => parseAnswer('no json', 4));
});

test('prompt contains the cue count and the timestamp block', () => {
  const cues = parseSrt(SRT_3);
  const p = buildPrompt(cues, { title: 'Synthetic' });
  assert.ok(p.includes('all 3 cues'));
  assert.ok(p.includes('00:00:01,000 --> 00:00:02,500'));
});

test('translateSrt end-to-end (mocked Gemini): same cues, byte-identical timestamps', async () => {
  await withFetch(
    [
      [
        'generativelanguage.googleapis.com',
        () =>
          new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"1":"ආයුබෝවන්","2":"ඔබ කොහෙද?","3":"හෙට හමුවෙමු."}' }] } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ],
    ],
    async () => {
      const src = parseSrt(SRT_3);
      const out = parseSrt(await translateSrt('test-key', SRT_3, { title: 'Synthetic' }));
      assert.equal(out.length, src.length);
      assert.deepEqual(out.map((c) => tc(c.start)), src.map((c) => tc(c.start)));
      assert.deepEqual(out.map((c) => tc(c.end)), src.map((c) => tc(c.end)));
      assert.ok(out.every((c) => SINHALA.test(c.text)));
    },
  );
});

// ---------------------------------------------------------------- sources

test('piratelk: WP-JSON hit is parsed, foreign download hosts rejected', async () => {
  const post = (href: string) => JSON.stringify([{
    slug: 'synthetic-movie-sinhala-subtitles',
    link: 'https://piratelk.com/synthetic-movie/',
    title: { rendered: 'Synthetic Movie (2008) &#8211; සිංහල උපසිරැසි' },
    content: { rendered: `<a href="${href}">Download</a> tt1234567` },
  }]);
  await withFetch([['piratelk.com/wp-json', () => new Response(post('https://piratelk.com/download/synthetic/?tmstv=1'), { status: 200 })]], async () => {
    const hits = await searchPiratelk('tt1234567', 0, 0, 'Synthetic Movie 2008');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].imdb, 'tt1234567');
    assert.ok(!hits[0].title.includes('සිංහල'), 'site suffix stripped');
  });
  await withFetch([['piratelk.com/wp-json', () => new Response(post('https://evil.example/download/x'), { status: 200 })]], async () => {
    assert.deepEqual(await searchPiratelk('tt1234567', 0, 0, 'Synthetic Movie 2008'), []);
  });
});

test('zoom.lk: relevance gate keeps the right film and drops others', async () => {
  const search = '<a href="https://zoom.lk/synthetic-movie-2024-sinhala-subtitle-sinhala/">x</a>';
  const postPage = '<a href="https://zoom.lk/sub-download/23752" class="sub-dl-btn">dl</a><span class="sub-dl-badge">2,748 HITS</span>';
  await withFetch(
    [
      ['zoom.lk/?s=', () => new Response(search, { status: 200 })],
      ['synthetic-movie-2024', () => new Response(postPage, { status: 200 })],
    ],
    async () => {
      const good = await searchZoomlk('Synthetic Movie 2024', 'tt1234567', 0, 0);
      assert.equal(good.length, 1);
      assert.equal(good[0].subDownloadId, 23752);
      assert.equal(good[0].hits, 2748);
      const bad = await searchZoomlk('Different Film', 'tt1234567', 0, 0);
      assert.equal(bad.length, 0, 'unrelated post must not be surfaced');
    },
  );
});

// ---------------------------------------------------------------- worker routes

test('manifest.json served by the Worker matches the repo manifest', async () => {
  const file = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const served = manifest();
  assert.equal(served.id, file.id);
  assert.deepEqual(served.types, file.types);
  assert.equal(served.resources[0].name, 'subtitles');

  const res = await worker.fetch(new Request('https://addon.test/manifest.json'), {}, devCtx().ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await res.json() as any;
  assert.equal(body.id, 'srilanka.sinhala.subs');
  assert.deepEqual(body.types, ['movie', 'series']);
});

test('CORS preflight and method guard', async () => {
  const opt = await worker.fetch(new Request('https://addon.test/manifest.json', { method: 'OPTIONS' }), {}, devCtx().ctx);
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('Access-Control-Allow-Origin'), '*');
  const post = await worker.fetch(new Request('https://addon.test/manifest.json', { method: 'POST' }), {}, devCtx().ctx);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Access-Control-Allow-Origin'), '*');
});

test('unknown route and malformed id', async () => {
  const nf = await worker.fetch(new Request('https://addon.test/nope'), {}, devCtx().ctx);
  assert.equal(nf.status, 404);
  const noId = await worker.fetch(new Request('https://addon.test/subtitles/movie/xyz.json'), {}, devCtx().ctx);
  assert.equal(noId.status, 200);
  assert.deepEqual(await noId.json(), { subtitles: [] });
});

test('subtitles route: absolute url, lang "sin", AnantPlay-safe shape', async () => {
  const osJson = JSON.stringify([{
    IDSubtitle: '42',
    SubFileName: 'Synthetic.Movie.2008.srt',
    SubLanguageID: 'si', // deliberately the alias: must be normalized to "sin"
    SubDownloadLink: OS_URL,
    SubDownloadsCnt: '1234',
    SubHearingImpaired: '0',
    SubFormat: 'srt',
  }]);
  await withFetch(
    [
      ['rest.opensubtitles.org', () => new Response(osJson, { status: 200 })],
      ['piratelk.com/wp-json', () => new Response('[]', { status: 200 })],
      ['zoom.lk', () => new Response('<html></html>', { status: 200 })],
    ],
    async () => {
      const res = await worker.fetch(
        new Request('https://addon.test/subtitles/movie/tt1234567.json?videoRelease=Synthetic%20Movie%202008'),
        {} as Env,
        devCtx().ctx,
      );
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.subtitles.length, 1);
      const row = body.subtitles[0];
      assert.equal(row.lang, 'sin', 'must never be "si" or AnantPlay drops the row');
      assert.match(row.url, /^https:\/\/addon\.test\/download\/v1[A-Za-z0-9_-]+\.srt$/);
      assert.ok(row.id && row.label, 'id + label present');
      assert.equal(row.origin, undefined, 'internal fields stripped');
    },
  );
});

test('download route: unknown token is 404, not 500', async () => {
  const res = await worker.fetch(new Request('https://addon.test/download/v1AAAAAAAA.srt'), {} as Env, devCtx().ctx);
  assert.equal(res.status, 404);
});

test('download route: serves normalized SRT from a mocked upstream gzip', async () => {
  const token = encodeToken({ o: 'opensubsLegacy', u: OS_URL, l: 'sin', r: 'Synthetic' });
  await withFetch([['dl.opensubtitles.org', () => new Response(GZIP_SRT, { status: 200 })]], async () => {
    const res = await worker.fetch(new Request(`https://addon.test/download/${token}.srt`), {} as Env, devCtx().ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    const body = await res.text();
    assert.ok(body.includes('-->'), 'SubFetch requires "-->": a 202 body must never look like a subtitle');
    assert.equal(parseSrt(body).length, 3);
  });
});

test('download route: tampered token cannot reach a non-allowlisted host', async () => {
  const token = encodeToken({ o: 'piratelk', u: 'https://evil.example/payload.zip', l: 'sin' });
  let called = false;
  await withFetch([['evil.example', () => { called = true; return new Response('x', { status: 200 }); }]], async () => {
    const res = await worker.fetch(new Request(`https://addon.test/download/${token}.srt`), {} as Env, devCtx().ctx);
    assert.equal(res.status, 502);
    assert.equal(called, false, 'the foreign host must never be fetched');
  });
  const weird = encodeToken({ o: 'nope', u: 'https://piratelk.com/download/x/', l: 'sin' });
  const res2 = await worker.fetch(new Request(`https://addon.test/download/${weird}.srt`), {} as Env, devCtx().ctx);
  assert.equal(res2.status, 502);
});

test('download route: RAR -> 202 + Retry-After, then served from pre-index', async () => {
  const rarUrl = 'https://dl.opensubtitles.org/en/download/sub/rar1.rar';
  const token = encodeToken({ o: 'opensubsLegacy', u: rarUrl, l: 'sin' });
  await withFetch([['dl.opensubtitles.org', () => new Response(RAR4, { status: 200 })]], async () => {
    const res = await worker.fetch(new Request(`https://addon.test/download/${token}.srt`), {} as Env, devCtx().ctx);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('Retry-After'), '3600');
    assert.equal(res.headers.get('Cache-Control'), 'no-store', 'a retry body must never be cached');
  });
  const env = { SUBS_INDEX: memKV({ [`preindex:${rarUrl}`]: SRT_3 }) } as Env;
  await withFetch([['dl.opensubtitles.org', () => new Response(RAR4, { status: 200 })]], async () => {
    const res = await worker.fetch(new Request(`https://addon.test/download/${token}.srt`), env, devCtx().ctx);
    assert.equal(res.status, 200);
    assert.equal(parseSrt(await res.text()).length, 3);
  });
});

test('translation without KV: translated inline (no un-servable 202)', async () => {
  const token = encodeToken({ o: 'opensubsLegacy', u: OS_URL, l: 'eng', r: 'Synthetic' });
  await withFetch(
    [
      ['dl.opensubtitles.org', () => new Response(GZIP_SRT, { status: 200 })],
      ['generativelanguage.googleapis.com', () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"1":"ආයුබෝවන්","2":"කොහෙද?","3":"හෙට."}' }] } }],
      }), { status: 200 })],
    ],
    async () => {
      const res = await worker.fetch(new Request(`https://addon.test/download/${token}.srt`), { GEMINI_API_KEY: 'k' } as Env, devCtx().ctx);
      assert.equal(res.status, 200);
      const cues = parseSrt(await res.text());
      assert.equal(cues.length, 3);
      assert.ok(cues.every((c) => SINHALA.test(c.text)));
    },
  );
});

test('translation with KV: first poll 202, then 200 from cache', async () => {
  const token = encodeToken({ o: 'opensubsLegacy', u: OS_URL, l: 'eng', r: 'Synthetic' });
  const env = { GEMINI_API_KEY: 'k', SUBS_INDEX: memKV() } as Env;
  await withFetch(
    [
      ['dl.opensubtitles.org', () => new Response(GZIP_SRT, { status: 200 })],
      ['generativelanguage.googleapis.com', () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"1":"ආයුබෝවන්","2":"කොහෙද?","3":"හෙට."}' }] } }],
      }), { status: 200 })],
    ],
    async () => {
      const first = devCtx();
      const res = await worker.fetch(new Request(`https://addon.test/download/${token}.srt`), env, first.ctx);
      assert.equal(res.status, 202);
      assert.equal(res.headers.get('Retry-After'), '10');
      await Promise.all(first.pending);
      const second = await worker.fetch(new Request(`https://addon.test/download/${token}.srt`), env, devCtx().ctx);
      assert.equal(second.status, 200);
      assert.equal(parseSrt(await second.text()).length, 3);
    },
  );
});

test('translation without a configured key is 503, never a broken 200', async () => {
  const token = encodeToken({ o: 'opensubsLegacy', u: OS_URL, l: 'eng' });
  await withFetch([['dl.opensubtitles.org', () => new Response(GZIP_SRT, { status: 200 })]], async () => {
    const res = await worker.fetch(new Request(`https://addon.test/download/${token}.srt`), {} as Env, devCtx().ctx);
    assert.equal(res.status, 503);
  });
});

test('health: reports every source status', async () => {
  await withFetch(
    [
      ['rest.opensubtitles.org', () => new Response('[]', { status: 200 })],
      ['piratelk.com', () => new Response('[]', { status: 200 })],
      ['zoom.lk', () => new Response('ok', { status: 200 })],
    ],
    async () => {
      const res = await worker.fetch(new Request('https://addon.test/health'), {} as Env, devCtx().ctx);
      const body = await res.json() as any;
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.deepEqual(body.sources, { opensubtitles: 200, piratelk: 200, 'zoom.lk': 200 });
    },
  );
});
