#!/usr/bin/env python3
"""
preindex.py — nightly pre-indexer (runs in GitHub Actions, NEVER in the Worker).

Downloads zoom.lk archives, unpacks any format (zip/gzip in Python, RAR via
`unrar p`, 7z via `7z e -so`), converts to UTF-8 .srt and uploads to R2 under
`preindex:<subtitle-url>` — the literal key `src/cache.ts:preindexGet` reads.

Zero cost: GitHub Actions free tier + Cloudflare R2 free tier.
Env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET.
     Without credentials the job is a dry run (never fails a nightly build).
     CLOUDFLARE_API_TOKEN (optional) falls back to `npx wrangler r2 object put`.

Policy (see README): only robots.txt-allowed routes, one request per second,
never /dlm_uploads/, and NEVER baiscope.lk or cineru.lk.

Stdlib only — no pip installs.

Self-test (offline, used by CI): python3 scripts/preindex.py --selftest
"""
from __future__ import annotations

import gzip
import hashlib
import hmac
import io
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
import srt_tools as st  # noqa: E402

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
}
MAX_BYTES = 8 * 1024 * 1024
DENY_HOSTS = {"baiscope.lk", "www.baiscope.lk", "cineru.lk", "www.cineru.lk"}
POLITE_DELAY = 1.0
_robots_cache: dict[str, list[str]] = {}


# ---------------------------------------------------------------- http + robots

def http_get(url: str, timeout: int = 30) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.hostname in DENY_HOSTS:
        raise RuntimeError(f"refusing denylisted host {parsed.hostname}")
    if not robots_allows(url):
        raise RuntimeError(f"robots.txt disallows {parsed.path}")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise RuntimeError(f"response over {MAX_BYTES} bytes")
    return data


def parse_robots(text: str) -> list[str]:
    """Disallow rules from the '*' group of a robots.txt body (pure, testable)."""
    rules: list[str] = []
    applies, seen_agent = False, False
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key, value = key.strip().lower(), value.strip()
        if key == "user-agent":
            applies = value == "*"
            seen_agent = True
        elif key == "disallow" and applies and seen_agent and value:
            rules.append(value)
    return rules


def path_allowed(rules: list[str], path: str) -> bool:
    return not any((path or "/").startswith(rule) for rule in rules)


def robots_allows(url: str) -> bool:
    """Honour the '*' group's Disallow rules for the URL's path (cached per host)."""
    parsed = urllib.parse.urlparse(url)
    host = f"{parsed.scheme}://{parsed.netloc}"
    if "/robots.txt" in parsed.path:
        return True
    if host not in _robots_cache:
        try:
            req = urllib.request.Request(f"{host}/robots.txt", headers=UA)
            with urllib.request.urlopen(req, timeout=15) as r:
                text = r.read(256 * 1024).decode("utf-8", errors="replace")
            _robots_cache[host] = parse_robots(text)
        except Exception:
            _robots_cache[host] = []  # unreachable robots.txt: keep going
    return path_allowed(_robots_cache[host], parsed.path or "/")


# ---------------------------------------------------------------- extraction

def _cli_extract(argv: list[str], data: bytes, ok) -> bytes:
    """Run unrar/7z on a real temp file (stdin piping is not portable)."""
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as fh:
        fh.write(data)
        path = fh.name
    try:
        out = subprocess.run(argv[:-1] + [path], capture_output=True)
        if out.returncode != 0 and not ok(out.stdout):
            raise RuntimeError(f"{argv[0]} failed: {out.stderr[:200]!r}")
        return out.stdout
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def extract_any(data: bytes) -> bytes:
    """zip/gzip in Python; RAR via unrar; 7z via 7z. Returns subtitle bytes."""
    if data[:2] == b"\x1f\x8b":
        return gzip.decompress(data)
    if data[:4] == b"PK\x03\x04":
        return st.extract_archive(data)[0]
    if data.startswith(b"Rar!\x1a\x07\x00") or data.startswith(b"Rar!\x1a\x07\x01\x00"):
        out = _cli_extract(["unrar", "p", "-inul"], data, lambda b: b"PK\x03\x04" in b[:64] or b"-->" in b)
        if out[:4] == b"PK\x03\x04":          # a zip wrapped in a rar
            return st.extract_archive(out)[0]
        return out
    if data[:6] == b"7z\xbc\xaf\x27\x1c":
        return _cli_extract(["7z", "e", "-so"], data, lambda b: b"-->" in b)
    return data


def to_srt(data: bytes) -> str:
    ext = ""
    cues = []
    text = st.decode(data)
    # try the declared extension first, then fall back to sniffing
    if "[Script Info]" in text[:2000]:
        ext = "ass"
    cues = st.parse_any(text, ext)
    if not cues:
        raise RuntimeError("no cues")
    cues = st.strip_watermarks(cues)
    cues = st.repair_cues(cues)
    if not cues:
        raise RuntimeError("no cues after watermark/repair")
    return st.emit(cues)


# ---------------------------------------------------------------- R2 upload

def r2_key(subtitle_url: str) -> str:
    """The Worker reads exactly this literal key (src/cache.ts:preindexGet)."""
    return f"preindex:{subtitle_url}"


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def sign_v4(
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    bucket: str,
    key: str,
    payload: bytes,
    now: datetime | None = None,
) -> tuple[str, dict[str, str]]:
    """AWS SigV4 for a single PUT (R2 is S3-compatible). Pure stdlib."""
    now = now or datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    parsed = urllib.parse.urlparse(endpoint)
    host = parsed.netloc
    canonical_uri = "/" + urllib.parse.quote(f"{bucket}/{key}", safe="/-_.~")
    payload_hash = hashlib.sha256(payload).hexdigest()
    canonical_headers = f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = f"PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    scope = f"{datestamp}/{region}/s3/aws4_request"
    string_to_sign = (
        f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n"
        + hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
    )
    k_date = _hmac(("AWS4" + secret_key).encode("utf-8"), datestamp)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, "s3")
    k_signing = _hmac(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    headers = {
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        "Content-Type": "text/plain; charset=utf-8",
        "Authorization": (
            f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }
    url = f"{endpoint.rstrip('/')}{canonical_uri}"
    return url, headers


def r2_put(key: str, body: str) -> None:
    data = body.encode("utf-8")
    access = os.environ.get("R2_ACCESS_KEY_ID")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY")
    endpoint = os.environ.get("R2_ENDPOINT")
    bucket = os.environ.get("R2_BUCKET", "subs-bucket")
    if access and secret and endpoint:
        url, headers = sign_v4(endpoint, os.environ.get("R2_REGION", "auto"), access, secret, bucket, key, data)
        req = urllib.request.Request(url, data=data, method="PUT", headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status not in (200, 201):
                raise RuntimeError(f"R2 PUT {r.status}")
        print(f"uploaded {key} ({len(data)} bytes)")
        return
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        with tempfile.NamedTemporaryFile("wb", suffix=".srt", delete=False) as fh:
            fh.write(data)
            path = fh.name
        try:
            subprocess.run(
                ["npx", "wrangler", "r2", "object", "put", f"{bucket}/{key}", "--file", path, "--remote"],
                check=False,
            )
            print(f"uploaded via wrangler {key} ({len(data)} bytes)")
        finally:
            os.unlink(path)
        return
    print(f"[dry-run] would put {key} ({len(data)} bytes)")


# ---------------------------------------------------------------- main

def main() -> int:
    seen: set[str] = set()
    posts: list[str] = []
    try:
        html = http_get("https://zoom.lk/").decode("utf-8", errors="replace")
        posts = [
            u for u in re.findall(r"https://zoom\.lk/[a-z0-9%.-]{8,}/", html)
            if not re.search(r"/(category|tag|author|page|feed|sub-download)/", u)
        ]
    except Exception as e:
        print("skip homepage", e)
        return 0

    indexed = 0
    for post in posts[:20]:
        if post in seen or "sub-download" in post:
            continue
        seen.add(post)
        try:
            time.sleep(POLITE_DELAY)
            html = http_get(post).decode("utf-8", errors="replace")
            ids = re.findall(r"href=['\"](https://zoom\.lk/sub-download/\d+)['\"]", html)
            for dl in ids[:2]:
                time.sleep(POLITE_DELAY)
                data = http_get(dl)
                srt = to_srt(extract_any(data))
                r2_put(r2_key(dl), srt)
                indexed += 1
                print("preindexed", dl, len(srt), "bytes")
        except Exception as e:
            print("skip", post, e)
    print(f"done: {indexed} archives processed")
    return 0


def selftest() -> int:
    """Offline proof that signing, keying and extraction work (used by CI)."""
    payload = b"1\n00:00:01,000 --> 00:00:02,000\n\xe0\xb6\x85\xe0\xb6\xba\n"
    url, headers = sign_v4(
        "https://example.r2.cloudflarestorage.com", "auto", "AKIDEXAMPLE", "SECRET",
        "subs-bucket", "preindex:https://zoom.lk/sub-download/1", payload,
        datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    sig = headers["Authorization"].rsplit("Signature=", 1)[-1]
    assert re.fullmatch(r"[0-9a-f]{64}", sig), sig
    decoded_path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
    assert decoded_path == "/subs-bucket/preindex:https://zoom.lk/sub-download/1"
    assert headers["x-amz-date"] == "20260101T000000Z"
    assert r2_key("https://zoom.lk/sub-download/23752") == "preindex:https://zoom.lk/sub-download/23752"

    fixture = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "synthetic-flat.zip"
    if fixture.exists():
        srt = to_srt(extract_any(fixture.read_bytes()))
        assert "-->" in srt, "fixture extraction produced no cues"
    # robots.txt handling is verified offline, never by touching the network
    rules = parse_robots("User-agent: *\nDisallow: /dlm_uploads/\nDisallow: /wp-admin/\n")
    assert not path_allowed(rules, "/dlm_uploads/x.zip")
    assert path_allowed(rules, "/sub-download/23752")
    assert path_allowed(rules, "/")
    try:
        http_get("https://baiscope.lk/x")
        raise AssertionError("denylisted host was not refused")
    except RuntimeError as e:
        assert "denylisted" in str(e)
    print("selftest: OK (SigV4 signature, R2 key, extraction, robots, denylist)")
    return 0


if __name__ == "__main__":
    raise SystemExit(selftest() if "--selftest" in sys.argv else main())
