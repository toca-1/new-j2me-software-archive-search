#!/usr/bin/env python3
"""Merge a hash-matched multi-ZIP collection into the J2ME site's upstream data.

Works with *_matches.csv produced by scan_upstream_zips.py. The website's
current upstream v1 catalog and 16 gzip shards are reused *without* changing
assets/app.js, assets/site.css, or the main search index.

Python 3.9+ and standard library only.

Example:
  python3 add_upstream_zip_collection.py \
    --repo ~/new-j2me-software-archive-search \
    --matches ~/j2me-waptrick-test/waptrick_matches.csv \
    --archive-id dump_waptrick_240x320_128x160 \
    --key waptrick --label Waptrick --expected-unique 10255
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import re
import shutil
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

HEX = "0123456789abcdef"
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
ITEM = re.compile(r"[A-Za-z0-9_.-]+\Z")
KEY = re.compile(r"[a-z0-9-]+\Z")
REQUIRED = {"sha256", "zip_file", "zip_member", "size_bytes", "member_url"}


def encoded_json(obj: object) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def valid_path(name: str) -> bool:
    return bool(name and not name.startswith("/") and "\\" not in name
                and all(c not in ("", ".", "..") for c in name.split("/"))
                and not any(ord(ch) < 32 or ord(ch) == 127 for ch in name))


def load_matches(path: Path, archive_id: str):
    options = defaultdict(set)  # sha256 -> {(zip_file, zip_member)}
    sizes = {}
    row_count = 0
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if not REQUIRED.issubset(reader.fieldnames or []):
            raise ValueError(f"Match CSV missing columns: {', '.join(sorted(REQUIRED - set(reader.fieldnames or [])))}")
        for n, row in enumerate(reader, 2):
            digest = (row["sha256"] or "").strip().lower()
            zip_file = row["zip_file"] or ""
            member = row["zip_member"] or ""
            if not SHA256.fullmatch(digest):
                raise ValueError(f"Line {n}: invalid SHA-256 {digest!r}")
            if (not valid_path(zip_file) or "/" in zip_file
                    or not zip_file.lower().endswith(".zip")):
                raise ValueError(f"Line {n}: invalid ZIP file name {zip_file!r}")
            if not valid_path(member) or not member.lower().endswith(".jar"):
                raise ValueError(f"Line {n}: invalid member name {member!r}")
            expected = (f"https://archive.org/download/{archive_id}/"
                        f"{quote(zip_file, safe='')}/{quote(member, safe='/')}")
            if row["member_url"] != expected:
                raise ValueError(f"Line {n}: member URL doesn't match archive/ZIP/path")
            try:
                size = int(row["size_bytes"])
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Line {n}: invalid JAR size") from exc
            if size < 0 or (digest in sizes and sizes[digest] != size):
                raise ValueError(f"Line {n}: inconsistent size for SHA-256 {digest}")
            sizes[digest] = size
            options[digest].add((zip_file, member))
            row_count += 1
    if not options:
        raise ValueError("No matched hashes in the CSV")
    # Keep one URL per content hash and upstream collection, even if the JAR is
    # repeated in different original ZIPs or many index source rows.
    selected = {digest: min(paths, key=lambda p: (len(p[0]) + len(p[1]), p))
                for digest, paths in options.items()}
    return selected, row_count, len({z for pairs in options.values() for z, _ in pairs})


def load_site_data(directory: Path):
    catalog_path = directory / "sources.json"
    if not catalog_path.is_file():
        raise ValueError("Missing data/upstream/sources.json; integrate Opera Mini first")
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    if (not isinstance(catalog, dict) or catalog.get("version") != 1
            or not isinstance(catalog.get("sources"), list)):
        raise ValueError("Unexpected upstream catalog version; stopping safely")
    sources = catalog["sources"]
    keys = [s.get("key") for s in sources if isinstance(s, dict)]
    if len(keys) != len(sources) or len(keys) != len(set(keys)):
        raise ValueError("Malformed or duplicate upstream source keys")
    shards = {}
    for prefix in HEX:
        path = directory / f"{prefix}.json.gz"
        if not path.is_file():
            raise ValueError(f"Missing upstream shard {path}")
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            shard = json.load(stream)
        if not isinstance(shard, dict):
            raise ValueError(f"Unexpected structure in {path}")
        for sha, entries in shard.items():
            if not SHA256.fullmatch(sha) or sha[0] != prefix or not isinstance(entries, list):
                raise ValueError(f"Invalid entry in {path}: {sha}")
            for entry in entries:
                if (not isinstance(entry, list) or len(entry) != 2
                        or type(entry[0]) is not int or not (0 <= entry[0] < len(sources))
                        or not isinstance(entry[1], str)):
                    raise ValueError(f"Invalid source mapping in {path}: {sha}")
        shards[prefix] = shard
    return sources, shards


def merge(sources, shards, matches, archive_id, key, label):
    old_keys = {s["key"] for s in sources if s["key"].startswith(key + ":")}
    zip_files = sorted({zipname for zipname, _ in matches.values()})
    new_keys = {f"{key}:{filename}" for filename in zip_files}
    if old_keys and old_keys != new_keys:
        raise ValueError("This collection was already added with a different ZIP set. "
                         "To avoid invalidating source indices, review the existing catalog first.")
    # Keep all other sources (especially Opera Mini) and their numeric IDs.
    index_by_key = {s["key"]: index for index, s in enumerate(sources)}
    for filename in zip_files:
        key_name = f"{key}:{filename}"
        source = {
            "key": key_name,
            "label": label,
            "base_url": (f"https://archive.org/download/{archive_id}/"
                         f"{quote(filename, safe='')}/"),
        }
        if key_name in index_by_key:
            if sources[index_by_key[key_name]] != source:
                raise ValueError(f"Existing source {key_name} has different settings")
        else:
            index_by_key[key_name] = len(sources)
            sources.append(source)
    group_indices = {index_by_key[k] for k in new_keys}
    # Idempotent: replace entries for the named group, not append duplicates.
    for shard in shards.values():
        for sha in list(shard):
            entries = [entry for entry in shard[sha] if entry[0] not in group_indices]
            if entries:
                shard[sha] = entries
            else:
                del shard[sha]
    for sha, (zip_file, member) in matches.items():
        shard = shards[sha[0]]
        shard.setdefault(sha, []).append([index_by_key[f"{key}:{zip_file}"], member])
    # Deterministic order and stable sha grouping.
    return {prefix: {sha: shards[prefix][sha] for sha in sorted(shards[prefix])}
            for prefix in HEX}, zip_files


def save_safely(data_dir: Path, sources, shards):
    target = data_dir / "upstream"
    with tempfile.TemporaryDirectory(prefix=".upstream-build-", dir=data_dir) as temp:
        root = Path(temp)
        stage = root / "next"
        stage.mkdir()
        (stage / "sources.json").write_bytes(
            encoded_json({"version": 1, "sources": sources}) + b"\n")
        for prefix in HEX:
            payload = encoded_json(shards[prefix])
            (stage / f"{prefix}.json.gz").write_bytes(
                gzip.compress(payload, compresslevel=9, mtime=0))
        previous = root / "previous"
        # Rename existing dir to a backup; restore it on any swap failure.
        os.replace(target, previous)
        try:
            os.replace(stage, target)
        except OSError:
            os.replace(previous, target)
            raise
        # Previous tree remains in the temp directory until we exit the scope.
    return sum(p.stat().st_size for p in target.iterdir() if p.is_file())


def update_documentation(repo: Path, label: str, archive_id: str, key: str,
                         count: int, zip_count: int):
    path = repo / "UPSTREAM_DOWNLOADS.md"
    if not path.is_file():
        return
    marker = f"<!-- upstream-collection:{key} -->"
    content = path.read_text(encoding="utf-8")
    if marker in content:
        return
    addition = (f"\n{marker}\n## {label} mapping\n\n"
                f"- Internet Archive item: https://archive.org/details/{archive_id}\n"
                f"- {zip_count:,} ZIP files, with **{count:,} SHA-256-matched JARs** "
                f"added as alternative download sources.\n"
                "- A single ZIP member is selected per unique hash in this collection; "
                "the generated CSVs are not committed.\n"
                "- Regenerate with `tools/add_upstream_zip_collection.py` and the "
                "matching scanner-produced CSV. Other sources remain intact.\n"
                "- Member links use Internet Archive's ZIP-member URLs, which may "
                "occasionally time out.\n")
    path.write_text(content.rstrip() + "\n" + addition, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", type=Path, default=Path("."),
                        help="Cloned website repository (default current directory)")
    parser.add_argument("--matches", type=Path, required=True,
                        help="Scanner's *_matches.csv file")
    parser.add_argument("--archive-id", required=True, help="Internet Archive item ID")
    parser.add_argument("--key", required=True, help="Collection key, e.g. waptrick")
    parser.add_argument("--label", required=True, help="Display name e.g. Waptrick")
    parser.add_argument("--expected-unique", type=int, default=0,
                        help="Expected unique SHA-256 matches; 0 means no check")
    args = parser.parse_args()
    if not ITEM.fullmatch(args.archive_id):
        parser.error("Bad --archive-id")
    if not KEY.fullmatch(args.key):
        parser.error("Bad --key; use lowercase letters/numbers/hyphens")
    if not args.label.strip() or len(args.label) > 90:
        parser.error("--label must be 1–90 characters")
    repo = args.repo.expanduser().resolve()
    csv_path = args.matches.expanduser().resolve()
    target_dir = repo / "data/upstream"
    if not (repo / "assets/app.js").is_file() or not target_dir.is_dir():
        parser.error("--repo must be the website repository with existing upstream data")
    if "downloadSourceRow" not in (repo / "assets/app.js").read_text(encoding="utf-8"):
        parser.error("Current website download list not found; review local version")
    if not csv_path.is_file():
        parser.error("Matches CSV not found")

    matches, row_count, all_zips = load_matches(csv_path, args.archive_id)
    if args.expected_unique and len(matches) != args.expected_unique:
        parser.error(f"Expected {args.expected_unique:,} matched hashes, got {len(matches):,}")
    if all_zips != 7 and args.key == "waptrick":
        parser.error(f"Expected all seven Waptrick ZIPs, but CSV covers {all_zips}; "
                     "scan the complete collection before publishing")
    print(f"Validated {row_count:,} joined CSV rows, {len(matches):,} distinct matches "
          f"across {all_zips} ZIPs.")
    sources, shards = load_site_data(target_dir)
    other_counts = defaultdict(int)
    for shard in shards.values():
        for entries in shard.values():
            for index, _ in entries:
                other_counts[sources[index]["key"].split(":")[0]] += 1
    shards, zips = merge(sources, shards, matches, args.archive_id, args.key, args.label)
    for prefix in HEX:
        for sha in shards[prefix]:
            if not any(sources[idx]["key"].startswith(args.key + ":")
                       for idx, _ in shards[prefix][sha]):
                continue
            # Verify that this collection always adds exactly one row per hash.
            assert sum(sources[idx]["key"].startswith(args.key + ":")
                       for idx, _ in shards[prefix][sha]) == 1
    total = save_safely(repo / "data", sources, shards)
    update_documentation(repo, args.label, args.archive_id, args.key,
                         len(matches), len(zips))
    print(f"Published {len(matches):,} {args.label} hashes (one URL per hash).")
    print(f"Wrote {len(sources)} total source entries and 16 gzip shards ({total:,} bytes).")
    if other_counts:
        print("Other existing collection entries before merge: " +
              ", ".join(f"{k}={v:,}" for k, v in sorted(other_counts.items())
                        if k != args.key))
    print("Main search index, app.js, and site.css were not changed.")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, json.JSONDecodeError, EOFError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
