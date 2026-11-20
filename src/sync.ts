/**
 * sync.ts — pure-TS cue-timeline aligner (no Python ffsubsync / Rust alass).
 * Computes a linear offset + FPS-ratio correction between an English reference
 * SRT and a target subtitle by cross-correlating cue START times.
 *
 * Audit fixes:
 *  - `med([])` returned NaN (empty/all-zero offsets -> NaN timestamps); median of
 *    an empty set is now 0
 *  - the constant-offset pass used `findIndex` inside a loop (O(n^2)); it now
 *    binary-searches like the FPS pass
 *  - applyAlign can no longer emit NaN/negative timestamps
 */

const FPS = [23.976, 24.0, 25.0, 29.97, 30.0];

const sorted = (a: number[]) => a.slice().sort((x, y) => x - y);

/** Median of a numeric array; 0 for an empty set (never NaN). */
export function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = sorted(a);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Index of the first value >= x in a sorted array. */
function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** The value in a sorted array closest to x (x itself when the array is empty-safe). */
function nearestValue(arr: number[], x: number): number {
  const i = lowerBound(arr, x);
  if (i >= arr.length) return arr[arr.length - 1];
  if (i === 0) return arr[0];
  return Math.abs(arr[i] - x) <= Math.abs(x - arr[i - 1]) ? arr[i] : arr[i - 1];
}

/** Nearest distance from x to any value in a sorted array. */
function nearestDistance(arr: number[], x: number): number {
  const i = lowerBound(arr, x);
  let best = Infinity;
  if (i < arr.length) best = Math.abs(arr[i] - x);
  if (i > 0) best = Math.min(best, Math.abs(arr[i - 1] - x));
  return best;
}

export function bestLinearFit(refStarts: number[], targetStarts: number[]): { offsetMs: number; fpsFrom?: number; fpsTo?: number; score: number } {
  const ref = sorted(refStarts.filter(Number.isFinite));
  const tgt = sorted(targetStarts.filter(Number.isFinite));
  if (ref.length < 8 || tgt.length < 8) return { offsetMs: 0, score: 0 };

  let best = { offsetMs: 0, score: 0 } as { offsetMs: number; fpsFrom?: number; fpsTo?: number; score: number };
  const stride = Math.max(1, Math.floor(tgt.length / 64));

  for (const f of FPS) {
    for (const t of FPS) {
      if (f === t) continue;
      const k = f / t; // a 25 fps subtitle on a 23.976 fps video drifts +4.17%
      const offs: number[] = [];
      for (let i = 0; i < tgt.length; i += stride) {
        const scaled = tgt[i] * k;
        const d = nearestValue(ref, scaled) - scaled;
        offs.push(Math.abs(d) < 2000 ? d : 0);
      }
      const nonZero = offs.filter((x) => x !== 0);
      const o = median(nonZero);
      let hits = 0;
      for (const s of ref) {
        if (nearestDistance(tgt, (s - o) / k) < 120) hits++;
      }
      const score = (hits / ref.length) * 0.92; // prior against FPS changes
      if (score > best.score) best = { offsetMs: Math.round(o), fpsFrom: f, fpsTo: t, score };
    }
  }

  // plain constant offset (k = 1)
  // Nearest reference cue, not the next one: using "next" biases the offset by
  // roughly one cue spacing and can win on score while aligning the wrong cue.
  const offs: number[] = tgt.map((s) => nearestValue(ref, s) - s);
  const o = median(offs);
  let hits = 0;
  for (const s of tgt) if (nearestDistance(ref, s + o) < 120) hits++;
  const score = hits / tgt.length;
  if (score > best.score) best = { offsetMs: Math.round(o), score };
  return best;
}

/** Apply an alignment: shift + optional FPS rescale. Non-finite results fall back to the original cue. */
export function applyAlign(cues: { start: number; end: number; text: string }[], offsetMs: number, fpsFrom?: number, fpsTo?: number) {
  const k = fpsFrom && fpsTo && fpsFrom !== fpsTo ? fpsFrom / fpsTo : 1;
  const off = Number.isFinite(offsetMs) ? offsetMs : 0;
  const ratio = Number.isFinite(k) && k > 0 ? k : 1;
  return cues.map((c) => {
    const start = c.start * ratio + off;
    const end = c.end * ratio + off;
    return {
      ...c,
      start: Number.isFinite(start) && start >= 0 ? start : c.start,
      end: Number.isFinite(end) && end >= 0 ? end : c.end,
    };
  });
}
