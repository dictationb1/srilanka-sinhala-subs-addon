#!/usr/bin/env python3
"""
srt_tools.py — shared SRT/ASS toolkit (Python twin of src/normalize.ts + src/srt.ts).

Stdlib only: no third-party packages are required to run this file or
scripts/preindex.py. (pytest is only needed for the test suite; see
tests/requirements.txt.)

Fixed defects, each covered by tests/test_srt_tools.py:

  Bug 1 (extract_archive):           nested-folder zips walked at ANY depth; only
                                     __MACOSX/, dotfiles and traversal names skipped.
  Bug 2 (watermark):                 strips credit/ad lines only at the edges or on
                                     explicit site matches; "Credit card" survives.
  Bug 3 (token_match):               lowercase Jaccard + release group after the
                                     final hyphen.
  Bug 4 (translate_cues):            batch translate with cue-count validation + retry.
  Bug 5 (timestamps):                reversed cues clamped, 0.5 s minimum duration,
                                     <=250 ms overlaps nudged, never end <= start.
  Bug 6 (wrap_si):                   wrapping no longer DROPS text past 4 lines.
  Bug 7 (ASS):                       ASS/SSA Dialogue lines are parsed, not silently
                                     turned into an empty subtitle.
  Bug 8 (decode):                    strict UTF-8 first, then windows-1252 (the old
                                     errors="replace" turned every legacy file into U+FFFD).
"""
from __future__ import annotations

import gzip
import io
import re
import zipfile
from typing import Iterable, Sequence

MAX_ARCHIVE_BYTES = 5 * 1024 * 1024   # SubFetch.java zip-bomb cap
EXT_RANK = {"srt": 0, "ass": 1, "ssa": 1, "vtt": 2}
_TIME = r"(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})"
TIME_RE = re.compile(_TIME + r"\s*-->\s*" + _TIME)


# ---------------------------------------------------------------- parse / emit

def _ms(h: str, m: str, s: str, f: str) -> int:
    return (int(h) * 3600 + int(m) * 60 + int(s)) * 1000 + int(f.ljust(3, "0")[:3])


def parse(text: str) -> list[dict]:
    """SRT-family text -> [{'start','end','text'}] (tolerates WEBVTT/ASS headers)."""
    out: list[dict] = []
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    for blk in re.split(r"\n{2,}", text):
        lines = [l for l in blk.split("\n") if l.strip()]
        if not lines:
            continue
        i = 1 if lines[0].strip().isdigit() else 0
        if i >= len(lines):
            continue
        m = TIME_RE.search(lines[i])
        if not m:
            continue
        body = "\n".join(lines[i + 1:])
        if body.strip():
            out.append({"start": _ms(*m.groups()[:4]), "end": _ms(*m.groups()[4:]), "text": body})
    return out


def parse_ass(text: str) -> list[dict]:
    """ASS/SSA [Events] Dialogue lines -> cues (commas inside the text are kept)."""
    out: list[dict] = []
    text = text.lstrip("\ufeff").replace("\r\n", "\n")
    pat = re.compile(
        r"^\s*Dialogue:\s*([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$",
        re.I,
    )
    for line in text.split("\n"):
        m = pat.match(line)
        if not m:
            continue
        s, e = re.search(_TIME, m.group(2)), re.search(_TIME, m.group(3))
        if not s or not e:
            continue
        body = strip_markup(m.group(10).replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ")).strip()
        if body:
            out.append({"start": _ms(*s.groups()), "end": _ms(*e.groups()), "text": body})
    return out


def parse_any(text: str, ext: str = "") -> list[dict]:
    """Dispatch on extension (ass/ssa -> parse_ass) so no container yields 0 cues."""
    e = (ext or "").lower()
    if e in ("ass", "ssa"):
        return parse_ass(text)
    if e == "vtt":
        text = re.sub(r"^\s*WEBVTT.*$", "", text, count=1, flags=re.M)

        def _vtt(m: re.Match) -> str:
            lead = "-->" if m.group(1) == "-->" else m.group(1)
            return f"{lead} 00:{m.group(2)}:{m.group(3)},{m.group(4)}" if lead == "-->" else f"{lead}00:{m.group(2)}:{m.group(3)},{m.group(4)}"

        text = re.sub(r"(^|\n|-->)\s*(\d{2}):(\d{2})[.,](\d{3})", _vtt, text)
        return parse(text)
    return parse(text)


def tc(millis) -> str:
    t = max(0, round(millis))
    return f"{t // 3600000:02d}:{t // 60000 % 60:02d}:{t // 1000 % 60:02d},{t % 1000:03d}"


def emit(cues: Iterable[dict]) -> str:
    return "\n".join(f"{i + 1}\n{tc(c['start'])} --> {tc(c['end'])}\n{c['text'].strip()}\n" for i, c in enumerate(cues))


def strip_markup(t: str) -> str:
    t = re.sub(r"\{\\[^}]*\}", "", t)                     # {\an8\c&H..&}
    t = re.sub(r"</?(?:font|b|i|u|ruby|p|v|span)[^>]*>", "", t, flags=re.I)
    return t.replace("\u00a0", " ").strip()


# ---------------------------------------------------------------- bug 2: watermark

KNOWN_WATERMARK = re.compile(
    r"(opensubtitles|osdb|podnapisi|subscene|yifysubtitles|addic7ed|piratelk|pirate ?lk|zoom\.lk|zoom lk"
    r"|sinhalasub|baiscope|cineru|www\.[a-z0-9-]+\.(?:lk|com|net|org)|https?://\S{6,})",
    re.I,
)

# A credit line must be an actual credit PHRASE. The old pattern allowed a bare
# "credits?\b", which stripped the real dialogue line "Credit card".
_HEAD_CREDIT = re.compile(
    r"^(?:[\[(]?\s*)?(?:(?:subtitles?|captions?|credits?|subs?)\s*(?:by|:)\s*\S.*"
    r"|(?:synced|syncing|ripped|encoded|translated|corrected|timed|edited)\s+by\s+\S.*"
    r"|(?:subtitles?|captions?)\s*)$",
    re.I,
)


def is_watermark(text: str, idx: int, total: int, edge: int = 5, max_len: int = 240) -> bool:
    """True only for ad/credit cues at the edges or explicit site mentions."""
    t = text.strip()
    if not t or len(t) > max_len:
        return False
    at_edge = idx < edge or idx >= total - edge
    if at_edge and (_HEAD_CREDIT.match(t) or KNOWN_WATERMARK.search(t)):
        return True
    # mid-file: only explicit site/domain/URL mentions, never sentence-like dialogue
    return bool(KNOWN_WATERMARK.search(t)) and not re.search(r"[.!?…\"'”]$|\b(is|are|was|the)\b", t, re.I)


def strip_watermarks(cues: list[dict]) -> list[dict]:
    return [c for i, c in enumerate(cues) if not is_watermark(strip_markup(c["text"]), i, len(cues))]


# ---------------------------------------------------------------- bug 5: timestamps

def repair_cues(cues: list[dict], min_dur_ms: int = 500, nudge_ms: int = 250) -> list[dict]:
    out, prev_end = [], 0
    for c in cues:
        try:
            start, end = float(c["start"]), float(c["end"])
        except (TypeError, ValueError):
            continue
        if start < 0:
            start = 0
        if end <= start or end - start < min_dur_ms:
            end = start + min_dur_ms
        if start < prev_end and prev_end - start <= nudge_ms:
            start = prev_end          # small overlap: push after the previous cue
            if end < start + min_dur_ms:
                end = start + min_dur_ms
        out.append({**c, "start": int(round(start)), "end": int(round(end))})
        prev_end = max(prev_end, out[-1]["end"])
    return out


def wrap_si(text: str, width: int = 40, max_lines: int | None = None) -> str:
    """Sinhala-safe wrap at spaces (Sinhala conjuncts must never break).

    max_lines is a display hint only: overflow is merged into the last line, so
    text is NEVER dropped (the old implementation truncated to 4 lines).
    """
    lines: list[str] = []
    for para in text.split("\n"):
        if len(para) <= width:
            lines.append(para)
            continue
        cur = ""
        for w in para.split(" "):
            if cur and len(cur) + 1 + len(w) > width:
                lines.append(cur)
                cur = w
            else:
                cur = f"{cur} {w}" if cur else w
        if cur:
            lines.append(cur)
    if max_lines and len(lines) > max_lines:
        lines = lines[: max_lines - 1] + [" ".join(lines[max_lines - 1:])]
    return "\n".join(lines)


# ---------------------------------------------------------------- bug 3: release scoring

_STOP = {
    "brrip", "bluray", "blu-ray", "webrip", "web", "webdl", "web-dl", "dvdrip", "dvdscr", "hdtv", "hdrip",
    "camrip", "hd", "sd", "hq", "hdrc", "hdr", "aac", "ac3", "dts", "dolby", "x264", "x265", "h264", "h265",
    "hevc", "xvid", "divx", "avc", "1080p", "720p", "480p", "360p", "2160p", "mp3", "aac2", "10bit", "8bit",
    "remastered", "extended", "unrated", "imax", "proper", "repack", "internal", "limited", "complete",
    "season", "s01",
}


def _tokens(s: str) -> set[str]:
    s = re.sub(r"[._\[\]()]+", " ", (s or "").lower())
    return {t for t in re.split(r"[\s-]+", s) if len(t) > 1 and t not in _STOP}


def _group(s: str) -> str:
    return re.sub(r"[^\w]", "", (s or "").lower().split("-")[-1]) if s else ""


def token_match(sub_release: str, video_release: str) -> float:
    """Lowercase Jaccard + same-ripper bonus + year penalty."""
    a, b = _tokens(sub_release), _tokens(video_release)
    if not a or not b:
        return 0.0
    inter = len(a & b)
    j = inter / (len(a) + len(b) - inter)
    ga, gb = _group(sub_release), _group(video_release)
    if ga and ga == gb and len(ga) >= 2:
        j = min(1.0, j + 0.25)
    ya = re.search(r"(19|20)\d{2}", sub_release or "")
    yb = re.search(r"(19|20)\d{2}", video_release or "")
    if ya and yb and ya.group() != yb.group():
        j *= 0.5
    return j


# ---------------------------------------------------------------- bug 1: archive extraction

def _safe(name: str) -> bool:
    return bool(name) and not name.startswith(("/", ".")) and "\\" not in name and ".." not in name


def pick_zip_entry(names: Sequence[str]) -> tuple[str, str] | None:
    """Best subtitle entry at ANY folder depth; __MACOSX/ and traversal skipped."""
    best = None
    for raw in names:
        n = raw.rstrip("/")
        if not _safe(n) or "__macosx" in n.lower() or n.split("/")[-1].startswith("._"):
            continue
        ext = n.lower().rsplit(".", 1)[-1]
        if ext not in EXT_RANK:
            continue
        if best is None or EXT_RANK[ext] < EXT_RANK[best[1]]:
            best = (n, ext)
    return best


def extract_archive(data: bytes) -> tuple[bytes, str]:
    """zip/gz bytes -> (best subtitle bytes, ext). RAR/7z raise (route to pre-indexer)."""
    if data[:2] == b"\x1f\x8b":
        out = gzip.decompress(data)
        if len(out) > MAX_ARCHIVE_BYTES:
            raise ValueError("unpacked subtitle over 5 MB cap")
        return out, "srt"
    if data[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = [i for i in z.infolist() if not i.is_dir()]
            # every entry counts against the cap, wanted or not (zip-bomb guard)
            if any(i.file_size > MAX_ARCHIVE_BYTES for i in infos):
                raise ValueError("archive entry over 5 MB cap")
            pick = pick_zip_entry([i.filename for i in infos])
            if pick is None:
                raise ValueError("no subtitle entry in zip")
            b = z.read(pick[0])
            if len(b) > MAX_ARCHIVE_BYTES:
                raise ValueError("entry over 5 MB cap")
            return b, pick[1]
    if data[:7] == b"Rar!\x1a\x07\x00" or data[:8] == b"Rar!\x1a\x07\x01\x00":
        raise ValueError("RAR: served pre-extracted from the nightly pre-indexer (R2)")
    if data[:6] == b"7z\xbc\xaf\x27\x1c":
        raise ValueError("7z: route to pre-indexer")
    return data, "srt"


# ---------------------------------------------------------------- bug 8: decode

def decode(b: bytes, hint: str = "") -> str:
    """BOM wins, then strict UTF-8, then windows-1252 — never silently U+FFFD."""
    if b[:3] == b"\xef\xbb\xbf":
        return b[3:].decode("utf-8", errors="replace")
    if b[:2] == b"\xff\xfe":
        return b[2:].decode("utf-16-le", errors="replace")
    if b[:2] == b"\xfe\xff":
        return b[2:].decode("utf-16-be", errors="replace")
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("cp1252", errors="replace")


# ---------------------------------------------------------------- bug 4: batch translate

def chunk_cues(cues: list[dict], size: int = 320) -> list[list[int]]:
    idx = list(range(len(cues)))
    return [idx[i: i + size] for i in range(0, len(idx), size)]


def translate_batch_impl(texts: list[str], translator, context: dict, retries: int = 2) -> list[str]:
    """translator(texts, context) -> list[str] of the same length (validated, retried)."""
    for _ in range(retries + 1):
        try:
            out = translator(texts, context)
            if len(out) != len(texts):
                raise ValueError(f"count mismatch {len(out)}/{len(texts)}")
            if any((t or "").strip() == "" for t in out):
                raise ValueError("empty translation in batch")
            return out
        except Exception:
            continue
    return texts   # graceful: keep the source lines rather than lose the batch


def translate_cues(cues: list[dict], translator, context: dict) -> list[dict]:
    """Batch translate with per-batch validation; timestamps copied verbatim."""
    out: list[dict] = []
    for batch in chunk_cues(cues):
        texts = [strip_markup(cues[i]["text"]).replace("\n", " | ") for i in batch]
        got = translate_batch_impl(texts, translator, context)
        for i, t in zip(batch, got):
            out.append({**cues[i], "text": t})
    return out


# ---------------------------------------------------------------- language normalization

def to_sin(lang: str) -> str:
    """'si'/'sin'/'sinh'/'si-lk' -> 'sin' (ISO 639-2/B that AnantPlay expects)."""
    l = (lang or "").strip().lower().replace("_", "-")
    return "sin" if l in ("si", "sin", "sinh", "si-lk", "sin-lk") else l


def ts_from_release(release: str) -> str:
    """Release name -> clean search title ('The.Dark.Knight.2008.1080p' -> 'The Dark Knight')."""
    t = re.sub(r"[._]+", " ", release or "")
    t = re.sub(r"\s*\(?(19|20)\d{2}\)?.*$", "", t).strip()
    return t[:60]
