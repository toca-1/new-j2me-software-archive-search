#!/usr/bin/env python3
"""Verified JARchive v11 downloader, by SHA-256 or SHA-1 (Python 3.9+).

Requires curl on PATH. Uses a local retrieval index when available, or lazily
fetches manifest.json and one SHA-256/SHA-1 shard from GitHub Pages.
SHA-1 searches need the sha1/ sidecar created by jarchive_sha1_build.py.

The download uses bounded HTTP byte-range requests, trying IA's live d1/d2
storage servers and canonical archive.org route; it NEVER uses the 7z member
extraction endpoint. No large local .7z archives are required.

Examples:
  python3 jarchive_download.py 4209a128a3f6ec3e2b60b72f76971f8d66366f505ae5e6b686a96620bd71d1bd
  python3 jarchive_download.py 714a033bcfb641bcf717e54f290a02352b7945fa
  python3 jarchive_download.py <hash> --dry-run
  python3 jarchive_download.py <hash> --index-url https://example.com/retrieval/v1
  python3 jarchive_download.py <hash> --index-offline --dry-run
  python3 jarchive_download.py <hash> --output game.jar
  python3 jarchive_download.py <hash> --stall-limit 180 --request-timeout 60
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
import gzip
import hashlib
import io
import os
import json
import lzma
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import zipfile
import zlib

MIB = 1024 * 1024
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
SHA1_RE = re.compile(r"[0-9a-f]{40}\Z")
CONTENT_RANGE_RE = re.compile(r"bytes\s+(\d+)-(\d+)/(\d+)\s*\Z", re.I)
STORAGE_SERVER_RE = re.compile(r"ia\d{4,8}\.us\.archive\.org\Z", re.I)
ITEM = "96x65pixels_j2me"
DEFAULT_BASE_URL = f"https://archive.org/download/{ITEM}"
ARCHIVE_NAMES = ("JARchiveLite_v11.7z", "JARchive_v11.7z")
DEFAULT_INDEX_URL = "https://toca-1.github.io/new-j2me-software-archive-search/retrieval/v1"
MAX_INDEX_BYTES = 8 * MIB
MAX_INDEX_JSON_BYTES = 32 * MIB


class RetrievalError(RuntimeError):
    """A request, index entry, or extraction failed safely."""


def require_curl():
    if not shutil.which("curl"):
        raise RetrievalError("curl executable not found; install with: sudo apt install curl")




def _validate_index_resource(raw: bytes, relative_name: str) -> None:
    """Validate complete JSON/gzip before caching a downloaded index resource."""
    try:
        if len(raw) > MAX_INDEX_BYTES:
            raise ValueError("index resource exceeds 8 MiB")
        if relative_name.endswith(".json.gz"):
            with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as fp:
                data = fp.read(MAX_INDEX_JSON_BYTES + 1)
                if len(data) > MAX_INDEX_JSON_BYTES:
                    raise ValueError("decompressed index resource exceeds 32 MiB")
                if fp.read(1):
                    raise ValueError("index resource exceeds decompression limit")
        else:
            data = raw
        obj = json.loads(data)
        if not isinstance(obj, dict):
            raise ValueError("index resource must contain a JSON object")
        if relative_name == "manifest.json":
            if (obj.get("schema_version") != 1 or obj.get("source_item") != ITEM
                    or not isinstance(obj.get("archives"), list)
                    or len(obj["archives"]) != 2
                    or obj.get("sha256_prefix_length") not in (1, 2)):
                raise ValueError("unexpected retrieval manifest format")
        else:
            kind, name = relative_name.split("/", 1)
            prefix = name.split(".")[0]
            if kind not in ("sha1", "sha256") or not re.fullmatch(r"[a-f0-9]{1,2}", prefix):
                raise ValueError("unexpected shard name")
            expected_len = 40 if kind == "sha1" else 64
            if not all(isinstance(k, str) and len(k) == expected_len
                       and k.startswith(prefix) and re.fullmatch(r"[0-9a-f]+", k)
                       for k in obj):
                raise ValueError("invalid digest key in index shard")
            if kind == "sha1" and not all(isinstance(v, str) and SHA256_RE.fullmatch(v)
                                            for v in obj.values()):
                raise ValueError("invalid SHA-1 mapping in index shard")
            if kind == "sha256" and not all(isinstance(v, list) for v in obj.values()):
                raise ValueError("invalid SHA-256 sources in index shard")
    except (ValueError, KeyError, EOFError, gzip.BadGzipFile, UnicodeError,
            OSError, zlib.error) as exc:
        raise RetrievalError(f"Invalid {relative_name}: {exc}") from exc


def _curl_index_resource(url: str, *, timeout: float) -> bytes:
    """Fetch one small metadata file using a hard wall-clock deadline."""
    require_curl()
    with tempfile.TemporaryDirectory(prefix="jarchive-index-") as temp:
        out = Path(temp) / "body"
        cmd = ["curl", "--silent", "--show-error", "--location", "--fail",
               "--proto", "=https,http", "--proto-redir", "=https,http",
               "--max-redirs", "4", "--connect-timeout", str(min(5.0, timeout)),
               "--max-time", str(timeout), "--max-filesize", str(MAX_INDEX_BYTES),
               "--header", "Accept-Encoding: identity", "--output", str(out),
               "--write-out", "%{http_code}", url]
        try:
            done = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  timeout=timeout + 2, check=False)
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise RetrievalError(f"Metadata download timed out or failed: {exc}") from exc
        status = done.stdout.decode("ascii", "replace").strip()
        if done.returncode or status != "200":
            details = done.stderr.decode("utf-8", "replace").strip()[-180:]
            raise RetrievalError(f"Metadata HTTP {status or 'unknown'}, curl exit "
                                 f"{done.returncode}: {details}")
        if not out.exists() or out.stat().st_size > MAX_INDEX_BYTES:
            raise RetrievalError("Missing or oversized index resource")
        return out.read_bytes()


class RemoteIndex:
    """Fetch at most the requested manifest/digest shards, with verified local cache."""
    def __init__(self, url: str, cache_dir: Path, *, offline: bool, timeout: float):
        parts = urllib.parse.urlsplit(url.rstrip("/"))
        if (not parts.netloc or parts.username or parts.password or parts.query or parts.fragment
                or (parts.scheme != "https" and not (
                    parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1")))):
            raise RetrievalError("Index URL must be HTTPS (HTTP allowed only for localhost tests)")
        if ".." in parts.path.split("/"):
            raise RetrievalError("Invalid index URL path")
        self.url = url.rstrip("/")
        self.root = cache_dir / "index" / hashlib.sha256(self.url.encode("utf-8")).hexdigest()[:20]
        self.offline = offline
        self.timeout = timeout
        self.hit_count = 0
        self.fetch_count = 0

    def get(self, relative: str) -> None:
        if not re.fullmatch(r"(?:manifest\.json|(?:sha1|sha256)/[a-f0-9]{1,2}\.json\.gz)", relative):
            raise RetrievalError(f"Disallowed index resource: {relative}")
        target = self.root / relative
        check = target.with_name(target.name + ".sha256")
        if target.is_file() and check.is_file():
            try:
                raw = target.read_bytes()
                digest = check.read_text("ascii").strip()
                if hashlib.sha256(raw).hexdigest() != digest:
                    raise RetrievalError("cached index checksum mismatch")
                _validate_index_resource(raw, relative)
                self.hit_count += 1
                return
            except (OSError, UnicodeError, RetrievalError):
                print(f"  Ignoring damaged cached {relative}", flush=True)
                target.unlink(missing_ok=True)
                check.unlink(missing_ok=True)
        if self.offline:
            raise RetrievalError(f"Missing cached index resource {relative}; "
                                 "run once online before using --index-offline")
        url = self.url + "/" + relative
        print(f"  Fetching index: {relative}", flush=True)
        raw = _curl_index_resource(url, timeout=self.timeout)
        _validate_index_resource(raw, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Publish the payload first and its checksum sidecar last: an interrupted
        # write cannot make an incomplete object appear valid on the next run.
        RangeCache._atomic_write(target, raw)
        RangeCache._atomic_write(check, (hashlib.sha256(raw).hexdigest()+"\n").encode("ascii"))
        self.fetch_count += 1

    def prepare(self, supplied: str) -> Path:
        self.get("manifest.json")
        if SHA1_RE.fullmatch(supplied):
            self.get(f"sha1/{supplied[:2]}.json.gz")
            sha256, _ = resolve_hash(self.root, supplied)
        else:
            sha256 = supplied
        with (self.root / "manifest.json").open(encoding="utf-8") as fp:
            manifest = json.load(fp)
        n = manifest["sha256_prefix_length"]
        self.get(f"sha256/{sha256[:n]}.json.gz")
        return self.root


def resolve_hash(root: Path, supplied: str) -> tuple[str, str | None]:
    """Resolve optional SHA-1 sidecar; return (canonical SHA-256, requested SHA-1)."""
    supplied = supplied.lower()
    if SHA256_RE.fullmatch(supplied):
        return supplied, None
    if not SHA1_RE.fullmatch(supplied):
        raise RetrievalError("Enter exactly 40 hex digits (SHA-1) or 64 (SHA-256)")
    shard = root / "sha1" / f"{supplied[:2]}.json.gz"
    if not shard.is_file():
        raise RetrievalError("SHA-1 lookup unavailable. Run jarchive_sha1_build.py "
                             "against your verified CSV to create the sha1/ shards.")
    with gzip.open(shard, "rt", encoding="utf-8") as stream:
        digest_map = json.load(stream)
    sha256 = digest_map.get(supplied)
    if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
        raise RetrievalError(f"SHA-1 not found in index: {supplied}")
    return sha256, supplied


def load_sources(root: Path, sha: str):
    with (root / "manifest.json").open("r", encoding="utf-8") as stream:
        manifest = json.load(stream)
    if manifest.get("schema_version") != 1 or manifest.get("source_item") != ITEM:
        raise RetrievalError("Unsupported or unexpected retrieval manifest")
    if not isinstance(manifest.get("archives"), list) or len(manifest["archives"]) != 2:
        raise RetrievalError("Malformed archive metadata")
    prefix_len = manifest.get("sha256_prefix_length")
    if prefix_len not in (1, 2):
        raise RetrievalError("Unsupported SHA-256 shard prefix length")
    with gzip.open(root / "sha256" / (sha[:prefix_len] + ".json.gz"), "rt", encoding="utf-8") as stream:
        records = json.load(stream)
    rows = records.get(sha)
    if not isinstance(rows, list) or not rows:
        raise RetrievalError(f"SHA-256 not found in index: {sha}")
    try:
        dict_mib = manifest["dictionary_mib"]
        if not isinstance(dict_mib, int) or not 1 <= dict_mib <= 256:
            raise ValueError("Invalid dictionary size")
        sources = []
        for coll, block_num, before, size, crc in rows:
            if type(coll) is not int or coll not in (0, 1):
                raise ValueError("Invalid collection")
            archive = manifest["archives"][coll]
            if archive["file"] != ARCHIVE_NAMES[coll]:
                raise ValueError("Unexpected archive name")
            archive_bytes = archive["bytes"]
            block_start, block_end, unpacked, resets = archive["blocks"][block_num]
            if not (0 <= block_start < block_end <= archive_bytes):
                raise ValueError("Invalid block bounds")
            if type(size) is not int or type(before) is not int:
                raise ValueError("Invalid member fields")
            if not (0 < size <= unpacked and 0 <= before <= unpacked - size):
                raise ValueError("Member out of block bounds")
            if not re.fullmatch(r"[0-9A-Fa-f]{8}", crc):
                raise ValueError("Invalid CRC")
            if not resets:
                raise ValueError("No independent restarts")
            restart_number = bisect_right([p[1] for p in resets], before) - 1
            if restart_number < 0:
                raise ValueError("No preceding restart")
            reset_at, reset_u = resets[restart_number]
            if not (block_start <= reset_at < block_end and 0 <= reset_u <= before):
                raise ValueError("Invalid restart location")
            # The next reset after the *end* of the member is an upper
            # bound on compressed data needed. It is not an exact transfer size.
            member_end = before + size
            after_end = bisect_right([p[1] for p in resets], member_end - 1)
            upper_end = resets[after_end][0] if after_end < len(resets) else block_end
            sources.append({
                "compressed_upper_bound": upper_end - reset_at,
                "collection": coll, "archive_name": archive["file"],
                "archive_bytes": archive_bytes, "block_number": block_num,
                "block_end": block_end, "before": before, "size": size,
                "crc": crc.upper(), "reset_absolute": reset_at,
                "reset_uncompressed": reset_u, "skip": before - reset_u,
                "dict_mib": dict_mib,
            })
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        raise RetrievalError(f"Malformed retrieval entry: {exc}") from exc
    sources.sort(key=lambda s: (s["skip"], s["collection"], s["reset_absolute"]))
    return sources


def curl_metadata(timeout_seconds: float) -> dict | None:
    """Read fresh IA storage location, bounded independently of socket timeouts."""
    if timeout_seconds < 1:
        return None
    url = f"https://archive.org/metadata/{ITEM}"
    command = ["curl", "--silent", "--show-error", "--location", "--fail",
               "--max-redirs", "3", "--connect-timeout", "4",
               "--max-time", str(round(timeout_seconds, 2)),
               "--max-filesize", str(8 * MIB), url]
    try:
        completed = subprocess.run(command, capture_output=True,
                                   timeout=timeout_seconds + 2, check=False)
        if completed.returncode:
            return None
        data = json.loads(completed.stdout)
        return data if isinstance(data, dict) else None
    except (OSError, subprocess.TimeoutExpired, ValueError, json.JSONDecodeError):
        return None


def discover_routes(base_url: str, metadata: dict | None, use_direct: bool = True) -> list[dict]:
    """Only accept IA-owned storage hostnames and a validated item directory."""
    result = []
    if use_direct and base_url.rstrip("/") == DEFAULT_BASE_URL and isinstance(metadata, dict):
        directory = metadata.get("dir")
        if isinstance(directory, str) and re.fullmatch(r"/\d+/items/96x65pixels_j2me", directory):
            potential = []
            for key in ("d1", "d2", "server"):
                potential.append(metadata.get(key))
            more = metadata.get("workable_servers")
            if isinstance(more, list):
                potential.extend(more)
            for host in potential:
                if (isinstance(host, str) and STORAGE_SERVER_RE.fullmatch(host)
                        and host not in [r["name"] for r in result]):
                    result.append({"name": host, "base": f"https://{host}{directory}"})
    result.append({"name": "archive.org (redirect)", "base": base_url.rstrip("/")})
    return result


def _final_response_headers(raw: bytes) -> dict:
    """Extract the last HTTP response, not proxy/redirect headers."""
    text = raw.decode("latin-1")
    blocks = re.split(r"\r?\n\r?\n", text)
    response = None
    for block in blocks:
        lines = block.splitlines()
        if lines and re.match(r"^HTTP/\S+\s+\d{3}", lines[0]):
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.strip().lower()] = value.strip()
            response = headers
    return response or {}


def curl_range(url: str, *, start: int, count: int, archive_bytes: int,
               timeout_seconds: float, connect_timeout: float) -> bytes:
    """One completely bounded HTTP request with strict 206/Content-Range checks."""
    end = start + count - 1
    if not (0 <= start <= end < archive_bytes):
        raise RetrievalError("Range exceeds archive bounds")
    if timeout_seconds < 0.5:
        raise RetrievalError("Overall time limit exhausted")
    with tempfile.TemporaryDirectory(prefix="jarchive-range-") as temp:
        body = Path(temp) / "range.bin"
        headers = Path(temp) / "headers.txt"
        command = [
            "curl", "--silent", "--show-error", "--location", "--fail",
            "--max-redirs", "4", "--proto", "=https", "--proto-redir", "=https",
            "--connect-timeout", str(round(min(connect_timeout, timeout_seconds), 2)),
            "--max-time", str(round(timeout_seconds, 2)),
            "--max-filesize", str(count),
            "--header", "Accept-Encoding: identity",
            "--header", "User-Agent: JARchive-LZMA2-range-downloader/2.0",
            "--range", f"{start}-{end}",
            "--dump-header", str(headers), "--output", str(body),
            "--write-out", "%{http_code}", url,
        ]
        try:
            done = subprocess.run(command, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE,
                                  timeout=timeout_seconds + 2, check=False)
        except subprocess.TimeoutExpired as exc:
            raise RetrievalError(f"Hard request timeout ({timeout_seconds:.1f}s)") from exc
        except OSError as exc:
            raise RetrievalError(f"curl failed to start: {exc}") from exc
        code = done.stdout.decode("ascii", errors="replace").strip()
        if done.returncode:
            if code.isdigit() and code != "000":
                raise RetrievalError(f"HTTP {code} (curl exit {done.returncode})")
            stderr = done.stderr.decode("utf-8", errors="replace").strip()
            raise RetrievalError(f"curl exit {done.returncode}: {stderr[-160:]}")
        if code != "206":
            raise RetrievalError(f"HTTP {code}: server did not honor byte range")
        actual_headers = _final_response_headers(headers.read_bytes())
        match = CONTENT_RANGE_RE.fullmatch(actual_headers.get("content-range", ""))
        if not match or tuple(map(int, match.groups())) != (start, end, archive_bytes):
            raise RetrievalError(f"Incorrect Content-Range: {actual_headers.get('content-range')!r}")
        if actual_headers.get("content-encoding", "identity").lower() != "identity":
            raise RetrievalError("Unexpected HTTP content encoding")
        if body.stat().st_size != count:
            raise RetrievalError(f"Incomplete range: expected {count:,}, received {body.stat().st_size:,}")
        return body.read_bytes()


def fetch_range(routes: list[dict], *, start: int, count: int, archive_bytes: int,
                deadline: float, request_timeout: float, connect_timeout: float,
                route_passes: int, verbose: bool = False) -> bytes:
    """Try multiple IA routes, with hard per-request and no-progress deadlines."""
    last_errors = []
    for cycle in range(route_passes):
        for route in list(routes):
            remaining = deadline - time.monotonic()
            if remaining < 0.5:
                raise RetrievalError("No successful HTTP range within the stall/time limit for range "
                                     f"{start:,}-{start+count-1:,}: " + "; ".join(last_errors))
            timeout = min(remaining, request_timeout)
            url = route["base"] + "/" + urllib.parse.quote(route["archive_name"])
            try:
                data = curl_range(url, start=start, count=count,
                                  archive_bytes=archive_bytes, timeout_seconds=timeout,
                                  connect_timeout=connect_timeout)
                current_index = next(i for i, r in enumerate(routes) if r is route)
                if current_index:
                    routes.insert(0, routes.pop(current_index))
                    print(f"  Switched to working route: {route['name']}", flush=True)
                return data
            except RetrievalError as exc:
                last_errors.append(f"{route['name']}: {exc}")
                if verbose:
                    print(f"  Range {start:,}-{start+count-1:,} failed via {route['name']}: {exc}", flush=True)
                else:
                    message = str(exc)
                    lower = message.lower()
                    if "resolving timed out" in lower or "could not resolve" in lower:
                        reason = "DNS lookup failed or timed out"
                    elif "ssl connection timeout" in lower:
                        reason = "SSL connection timed out"
                    elif "timeout" in lower or "timed out" in lower:
                        reason = "Request timed out"
                    elif message.startswith("HTTP "):
                        reason = message.split(" (", 1)[0].split(":", 1)[0]
                    else:
                        reason = "Request failed"
                    print(f"  {reason} via {route['name']}; trying another route or retrying...", flush=True)
        if cycle + 1 < route_passes:
            time.sleep(min(0.6, max(0, deadline - time.monotonic())))
    raise RetrievalError("All storage routes failed for range "
                         f"{start:,}-{start+count-1:,}: " + "; ".join(last_errors))


class RangeCache:
    """Durable, per-source storage of independently validated HTTP 206 ranges.

    A range becomes reusable only after both its exact-size bytes and local
    SHA-256 sidecar have been atomically written. The cache is namespaced by
    the expected JAR digest *and* archive identity/offset parameters.
    """
    def __init__(self, base: Path, source: dict, sha256: str, enabled: bool):
        self.enabled = enabled
        if not enabled:
            self.directory = None
            return
        identity = {
            "schema": 1, "item": ITEM, "sha256": sha256,
            "archive": source["archive_name"], "archive_bytes": source["archive_bytes"],
            "block": source["block_number"], "block_end": source["block_end"],
            "restart": source["reset_absolute"], "uncompressed_at_restart": source["reset_uncompressed"],
            "dict_mib": source["dict_mib"],
        }
        fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:20]
        self.directory = (base / sha256[:2] / sha256 /
                          f"{source['collection']}-b{source['block_number']}-"
                          f"r{source['reset_absolute']}-{fingerprint}")

    def _paths(self, start: int, count: int):
        filename = f"{start}-{count}.bin"
        return self.directory / filename, self.directory / (filename + ".sha256")

    def read(self, start: int, count: int) -> bytes | None:
        if not self.enabled:
            return None
        data_path, digest_path = self._paths(start, count)
        if not data_path.is_file() or not digest_path.is_file():
            return None
        try:
            if data_path.stat().st_size != count:
                raise ValueError("incorrect cached range length")
            expected = digest_path.read_text(encoding="ascii").strip()
            if not SHA256_RE.fullmatch(expected):
                raise ValueError("incorrect cached digest")
            data = data_path.read_bytes()
            if len(data) != count or hashlib.sha256(data).hexdigest() != expected:
                raise ValueError("cached range checksum mismatch")
            return data
        except (OSError, UnicodeError, ValueError):
            print(f"  Discarding damaged/incomplete cached range {start:,}+{count:,}", flush=True)
            for path in (digest_path, data_path):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            return None

    @staticmethod
    def _atomic_write(path: Path, data: bytes):
        # Write in the destination directory, then atomically publish a name.
        import tempfile
        fd, temp_name = tempfile.mkstemp(prefix=".range-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_name, path)
        finally:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass

    def save(self, start: int, data: bytes):
        if not self.enabled:
            return
        data_path, digest_path = self._paths(start, len(data))
        self.directory.mkdir(parents=True, exist_ok=True)
        self._atomic_write(data_path, data)
        self._atomic_write(digest_path, (hashlib.sha256(data).hexdigest() + "\n").encode("ascii"))


def extract_one(source: dict, sha256: str, *, expected_sha1: str | None,
                max_download_mib: int, max_jar_mib: int, chunk_kib: int,
                routes: list[dict], absolute_deadline: float | None,
                stall_limit: float, request_timeout: float,
                connect_timeout: float, route_passes: int, cache_dir: Path,
                use_cache: bool, verbose: bool = False):
    before, size = source["before"], source["size"]
    if size > max_jar_mib * MIB:
        raise RetrievalError(f"JAR size {size:,} exceeds --max-jar-mib {max_jar_mib}")
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[
        {"id": lzma.FILTER_LZMA2, "dict_size": source["dict_mib"] * MIB}
    ])
    routes = [dict(r, archive_name=source["archive_name"]) for r in routes]
    cache = RangeCache(cache_dir, source, sha256, use_cache)
    uncompressed_at, compressed_at = source["reset_uncompressed"], source["reset_absolute"]
    end = before + size
    needed_uncompressed = end - uncompressed_at
    output = bytearray()
    processed_compressed = 0
    network_bytes = 0
    cached_bytes = 0
    stalls = 0
    report_at = time.monotonic()
    start_time = report_at
    last_progress = start_time
    limit = max_download_mib * MIB
    print(f"  Required decoded span: {needed_uncompressed/MIB:.1f} MiB", flush=True)
    print(f"  Compressed transfer upper bound: "
          f"{source['compressed_upper_bound']/MIB:.1f} MiB (next reset or block end).", flush=True)
    if verbose:
        print(f"  Request size: {chunk_kib} KiB; per-request timeout: {request_timeout:g}s; "
              f"stall limit: {stall_limit:g}s", flush=True)
    while uncompressed_at < end:
        if decoder.eof:
            raise RetrievalError("LZMA2 stream ended before requested JAR")
        if decoder.needs_input:
            available = min(limit - processed_compressed, source["block_end"] - compressed_at)
            if available <= 0:
                raise RetrievalError(f"Compressed block ended or download cap reached ({max_download_mib} MiB)")
            count = min(chunk_kib * 1024, available)
            if count < 1:
                raise RetrievalError("No compressed bytes available")
            chunk = cache.read(compressed_at, count)
            if chunk is not None:
                cached_bytes += len(chunk)
                last_progress = time.monotonic()
            else:
                deadline = last_progress + stall_limit
                if absolute_deadline is not None:
                    deadline = min(deadline, absolute_deadline)
                if deadline - time.monotonic() <= 0:
                    raise RetrievalError("No successful HTTP range within stall/time limit")
                chunk = fetch_range(routes, start=compressed_at, count=count,
                                    archive_bytes=source["archive_bytes"], deadline=deadline,
                                    request_timeout=request_timeout,
                                    connect_timeout=connect_timeout, route_passes=route_passes,
                                    verbose=verbose)
                network_bytes += len(chunk)
                last_progress = time.monotonic()
                try:
                    cache.save(compressed_at, chunk)
                except OSError as exc:
                    print(f"  Warning: could not save cached range: {exc}", flush=True)
            compressed_at += len(chunk)
            processed_compressed += len(chunk)
        else:
            chunk = b""
        try:
            decoded = decoder.decompress(chunk, max_length=MIB)
        except (lzma.LZMAError, EOFError) as exc:
            raise RetrievalError(f"LZMA2 decoding failed at byte {compressed_at:,}: {exc}; "
                                 "try --no-cache if cached ranges may be wrong") from exc
        following = uncompressed_at + len(decoded)
        overlap_start, overlap_end = max(uncompressed_at, before), min(following, end)
        if overlap_end > overlap_start:
            output.extend(decoded[overlap_start-uncompressed_at:overlap_end-uncompressed_at])
        uncompressed_at = following
        if not decoded and not chunk:
            stalls += 1
            if stalls > 4:
                raise RetrievalError("LZMA2 decoder stalled")
        else:
            stalls = 0
        now = time.monotonic()
        if now - report_at >= 4 and processed_compressed:
            percent = min(100, 100 * (uncompressed_at - source["reset_uncompressed"]) / needed_uncompressed)
            print(f"  Decoded {percent:5.1f}% | "
                  f"{min(needed_uncompressed, max(0, uncompressed_at-source['reset_uncompressed']))/MIB:.1f}/"
                  f"{needed_uncompressed/MIB:.1f} MiB | "
                  f"downloaded {network_bytes/MIB:.1f} MiB | "
                  f"cached {cached_bytes/MIB:.1f} MiB | "
                  f"{now-start_time:.0f}s", flush=True)
            report_at = now
    result = bytes(output)
    if len(result) != size:
        raise RetrievalError(f"JAR size mismatch: {len(result)} != {size}")
    crc = f"{zlib.crc32(result) & 0xFFFFFFFF:08X}"
    if crc != source["crc"]:
        raise RetrievalError(f"CRC32 mismatch: {crc} != {source['crc']}")
    if hashlib.sha256(result).hexdigest() != sha256:
        raise RetrievalError("SHA-256 mismatch")
    if expected_sha1 and hashlib.sha1(result).hexdigest() != expected_sha1:
        raise RetrievalError("SHA-1 mismatch")
    try:
        with zipfile.ZipFile(io.BytesIO(result), "r") as jar:
            if not jar.infolist():
                raise RetrievalError("Recovered JAR is an empty ZIP")
            bad = jar.testzip()
            if bad is not None:
                raise RetrievalError(f"Invalid ZIP member CRC: {bad}")
    except (zipfile.BadZipFile, RuntimeError) as exc:
        raise RetrievalError(f"Recovered JAR failed ZIP verification: {exc}") from exc
    return result, network_bytes, cached_bytes


def publish_verified_jar(output: Path, content: bytes) -> None:
    """Publish only a complete verified JAR, never a partially written output."""
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".part",
                                     dir=output.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        # Atomic create-if-absent: another process cannot be silently overwritten.
        os.link(temp_name, output)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument("hash", help="SHA-1 (40 hex) or SHA-256 (64 hex)")
    parser.add_argument("--index", type=Path, default=None,
                        help="Use a local index directory (overrides automatic remote lookup)")
    parser.add_argument("--index-url", default=None,
                        help=f"Fetch lookup shards from a remote URL (default: {DEFAULT_INDEX_URL})")
    parser.add_argument("--index-offline", action="store_true",
                        help="Use cached remote index resources without metadata HTTP requests")
    parser.add_argument("--index-fetch-timeout", type=float, default=20,
                        help="Hard time limit for each remote manifest/shard request")
    parser.add_argument("--output", type=Path, help="Output JAR name (default: SHA-256.jar)")
    parser.add_argument("--source", choices=("auto", "lite", "full"), default="auto")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--no-direct", action="store_true", help="Disable IA datanode discovery")
    parser.add_argument("--metadata-timeout", type=float, default=7)
    parser.add_argument("--time-limit", type=float, default=0,
                        help="Optional maximum total runtime in seconds (0 disables; default)")
    parser.add_argument("--stall-limit", type=float, default=120,
                        help="Maximum seconds without a successful downloaded range")
    parser.add_argument("--request-timeout", type=float, default=45,
                        help="Hard time limit for one HTTP Range request")
    parser.add_argument("--connect-timeout", type=float, default=5)
    parser.add_argument("--route-passes", type=int, default=2,
                        help="Maximum complete passes through available hosts per range")
    parser.add_argument("--chunk-kib", type=int, default=1024)
    parser.add_argument("--max-download-mib", type=int, default=512)
    parser.add_argument("--max-jar-mib", type=int, default=128)
    parser.add_argument("--cache-dir", type=Path, default=Path(".jarchive-cache"),
                        help="Where to keep verified-complete HTTP range chunks for resume")
    parser.add_argument("--no-cache", action="store_true", help="Disable reading/writing resumed ranges")
    parser.add_argument("--verbose", action="store_true",
                        help="Show source offsets, request settings and full errors for each route attempt")
    args = parser.parse_args(argv)

    supplied = args.hash.lower()
    if not SHA256_RE.fullmatch(supplied) and not SHA1_RE.fullmatch(supplied):
        parser.error("hash must be 40 (SHA-1) or 64 (SHA-256) hexadecimal characters")
    for attr in ("metadata_timeout", "stall_limit", "request_timeout", "connect_timeout",
                 "chunk_kib", "max_download_mib", "max_jar_mib"):
        if getattr(args, attr) <= 0:
            parser.error(f"--{attr.replace('_', '-')} must be positive")
    if args.time_limit < 0:
        parser.error("--time-limit must be >= 0 (0 means disabled)")
    if not 1 <= args.route_passes <= 5:
        parser.error("--route-passes must be between 1 and 5")
    if args.chunk_kib > 4096:
        parser.error("--chunk-kib may not exceed 4096")
    if args.index_fetch_timeout <= 0:
        parser.error("--index-fetch-timeout must be positive")
    if args.index is not None and args.index_url is not None:
        parser.error("Specify either --index or --index-url, not both")

    if args.index is not None:
        if not (args.index / "manifest.json").is_file():
            raise RetrievalError(f"Local index not found at {args.index}")
        index_root = args.index
        print(f"Using local index: {index_root}", flush=True)
    elif args.index_url is None and Path("jarchive-retrieval-v1/manifest.json").is_file():
        index_root = Path("jarchive-retrieval-v1")
        print(f"Using local index: {index_root}", flush=True)
    else:
        remote = RemoteIndex(args.index_url or DEFAULT_INDEX_URL, args.cache_dir,
                             offline=args.index_offline, timeout=args.index_fetch_timeout)
        print(f"Using remote index: {remote.url}", flush=True)
        index_root = remote.prepare(supplied)
        print(f"Index resources: {remote.fetch_count} downloaded, "
              f"{remote.hit_count} reused from cache", flush=True)

    sha256, expected_sha1 = resolve_hash(index_root, supplied)
    output = args.output or Path(sha256 + ".jar")
    if not args.dry_run and output.exists():
        parser.error(f"Output exists (will not overwrite): {output}")
    sources = load_sources(index_root, sha256)
    if args.source != "auto":
        coll = 0 if args.source == "lite" else 1
        sources = [s for s in sources if s["collection"] == coll]
        if not sources:
            raise RetrievalError(f"No {args.source} source for this hash")

    if expected_sha1:
        print(f"SHA-1:   {expected_sha1}\nSHA-256: {sha256}")
    else:
        print(f"SHA-256: {sha256}")
    print(f"Available sources: {len(sources)}")
    for n, source in enumerate(sources, 1):
        details = (f" block {source['block_number']}" if args.verbose else "")
        details += f" | JAR {source['size']:,} bytes"
        if args.verbose:
            details += (f" | skip {source['skip']:,} bytes"
                        f" | archive restart {source['reset_absolute']:,}")
        print(f"  {n}. {source['archive_name']}{details} "
              f"| compressed upper bound {source['compressed_upper_bound']/MIB:.1f} MiB")
    if args.dry_run:
        print("Dry run: no archive ranges downloaded (remote index lookup may use HTTP).")
        return 0

    require_curl()
    absolute_deadline = time.monotonic() + args.time_limit if args.time_limit else None
    metadata = None
    if not args.no_direct and args.base_url.rstrip("/") == DEFAULT_BASE_URL:
        print(f"Locating Internet Archive storage servers ({args.metadata_timeout:g}s limit)...", flush=True)
        metadata = curl_metadata(min(args.metadata_timeout, max(0, absolute_deadline-time.monotonic()))
                                 if absolute_deadline is not None else args.metadata_timeout)
        if metadata is None:
            print("  IA metadata unavailable; trying canonical archive.org route only.", flush=True)
    routes = discover_routes(args.base_url, metadata, not args.no_direct)
    print("HTTP routes: " + ", ".join(route["name"] for route in routes), flush=True)
    errors = []
    for n, source in enumerate(sources, 1):
        print(f"\nTrying source {n}/{len(sources)}: {source['archive_name']}...", flush=True)
        try:
            result, transferred, reused = extract_one(source, sha256, expected_sha1=expected_sha1,
                max_download_mib=args.max_download_mib, max_jar_mib=args.max_jar_mib,
                chunk_kib=args.chunk_kib, routes=routes, absolute_deadline=absolute_deadline,
                stall_limit=args.stall_limit, request_timeout=args.request_timeout,
                connect_timeout=args.connect_timeout, route_passes=args.route_passes,
                cache_dir=args.cache_dir, use_cache=not args.no_cache, verbose=args.verbose)
            publish_verified_jar(output, result)
            print(f"New successfully downloaded range bytes: {transferred:,} ({transferred/MIB:.2f} MiB)")
            print(f"Verified cached range bytes reused: {reused:,} ({reused/MIB:.2f} MiB)")
            print(f"SHA-256 verified: {sha256}")
            if expected_sha1:
                print(f"SHA-1 verified: {expected_sha1}")
            print("\n" + "-" * 72)
            print(f"PASS: saved verified JAR to\n{output}")
            print("-" * 72, flush=True)
            return 0
        except RetrievalError as exc:
            if not args.verbose:
                print(f"  Failed source details: block {source['block_number']} | "
                      f"skip {source['skip']:,} bytes | archive restart {source['reset_absolute']:,}",
                      file=sys.stderr, flush=True)
                print(f"  Request size: {args.chunk_kib} KiB; per-request timeout: {args.request_timeout:g}s; "
                      f"stall limit: {args.stall_limit:g}s", file=sys.stderr, flush=True)
            print(f"  Source failed: {exc}", file=sys.stderr, flush=True)
            errors.append(f"{source['archive_name']}: {exc}")
    raise RetrievalError("No verified JAR could be recovered. The archive storage may be "
                         "temporarily unavailable; retry later.\n  " + "\n  ".join(errors))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInterrupted; successfully downloaded ranges are preserved in .jarchive-cache/ ",
              "(or the --cache-dir path). Rerun the same command to resume.", file=sys.stderr)
        sys.exit(130)
    except (RetrievalError, OSError, EOFError, gzip.BadGzipFile, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
