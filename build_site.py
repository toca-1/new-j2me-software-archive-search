#!/usr/bin/env python3
"""Build JARchive v4 static search data from the independently verified enriched CSV.

No JAR extraction or hashing. Input and original metadata sidecar are read-only.
The generated site is self-contained and works on GitHub Pages / Python http.server.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import os
import re
import shutil
import sqlite3
import tempfile
from collections import Counter
from pathlib import Path

COLLECTIONS = {"JARchiveLite v11": 0, "JARchive v11": 1}
ARCHIVES = {0: "JARchiveLite_v11.7z", 1: "JARchive_v11.7z"}
REQUIRED = {
    "collection", "filename", "archive_path", "size_bytes", "crc32", "sha1", "sha256",
    "archive_file", "metadata_status", "midlet_name", "midlet_vendor", "midlet_version", "cldc", "midp",
}
SHA1 = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
CRC = re.compile(r"[0-9A-F]{8}\Z")


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(compact_json(value), encoding="utf-8")


def write_gzip(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = compact_json(value).encode("utf-8")
    path.write_bytes(gzip.compress(raw, compresslevel=6, mtime=0))


def clean_manifest(manifest):
    if not isinstance(manifest, dict):
        return {}
    result = {}
    for key, value in manifest.items():
        if isinstance(value, (str, int, float, bool)) and value is not None:
            result[str(key)[:120]] = str(value)[:4000]
    return result


def load_details(db: sqlite3.Connection, file: Path, max_paths: int):
    print("Importing manifest details (read-only source)...", flush=True)
    db.execute("CREATE TABLE details (sha256 TEXT NOT NULL, coll INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (sha256,coll)) WITHOUT ROWID")
    count = 0
    batch = []
    with gzip.open(file, "rt", encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            d = json.loads(line)
            coll = COLLECTIONS.get(d.get("collection"))
            sha = str(d.get("sha256", "")).lower()
            if coll is None or not SHA256.fullmatch(sha):
                raise ValueError(f"Malformed details entry at line {count + 1}")
            all_paths = d.get("paths", [])
            if not isinstance(all_paths, list):
                all_paths = []
            shown = all_paths if max_paths < 0 else all_paths[:max_paths]
            # Each source's exact original locations are preserved in the master
            # details JSONL. Limit published locations unless explicitly opted in.
            payload = [clean_manifest(d.get("manifest")), [str(x) for x in shown], len(all_paths)]
            batch.append((sha, coll, compact_json(payload)))
            count += 1
            if len(batch) >= 10000:
                db.executemany("INSERT INTO details VALUES (?,?,?)", batch)
                batch.clear()
                if count % 100000 == 0:
                    print(f"  Imported {count:,} detail records...", flush=True)
        if batch:
            db.executemany("INSERT INTO details VALUES (?,?,?)", batch)
    print(f"  Imported {count:,} detail records", flush=True)
    return count


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", required=True, type=Path, help="jarchive-enriched.csv")
    p.add_argument("--details", required=True, type=Path, help="jarchive-enriched-details.jsonl.gz")
    p.add_argument("--out", required=True, type=Path, help="unpacked v4 website folder")
    p.add_argument("--expected-count", type=int, default=816215)
    p.add_argument("--record-chunk", type=int, default=4096, help="records per compressed chunk")
    p.add_argument("--name-shards", type=int, default=64, help="approximate number of filename/title search shards")
    p.add_argument("--max-original-paths", type=int, default=2,
                   help="original source paths to show per manifest (0 none; -1 all)")
    p.add_argument("--warn-mib", type=int, default=250, help="warn when published data exceeds this size")
    a = p.parse_args()
    if a.record_chunk < 100 or a.name_shards < 1 or a.max_original_paths < -1:
        p.error("Invalid chunk, shards or original paths option")
    source = a.input.expanduser().resolve(strict=True)
    details_path = a.details.expanduser().resolve(strict=True)
    out = a.out.expanduser().resolve()
    if not (out / "index.html").exists() or not (out / "assets" / "app.js").exists():
        p.error("--out must be the unpacked v4 site folder with index.html and assets/app.js")
    next_data = out / ".data-v4-staging"
    if next_data.exists():
        raise RuntimeError(f"Staging directory already exists: {next_data} (inspect/remove it before retrying)")

    with tempfile.TemporaryDirectory(prefix="jarchive-v4-") as tempdir:
        db = sqlite3.connect(str(Path(tempdir) / "build.sqlite"))
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("PRAGMA synchronous=OFF")
        db.execute("PRAGMA temp_store=FILE")
        db.execute("""CREATE TABLE entries (
            sha256 TEXT NOT NULL, sha1 TEXT NOT NULL, size INTEGER NOT NULL, coll INTEGER NOT NULL,
            filename TEXT NOT NULL, path TEXT NOT NULL, crc TEXT NOT NULL,
            title TEXT NOT NULL, vendor TEXT NOT NULL, version TEXT NOT NULL,
            cldc TEXT NOT NULL, midp TEXT NOT NULL)""")
        db.execute("CREATE TABLE lookup(sha256 TEXT PRIMARY KEY, sha1 TEXT NOT NULL, id INTEGER NOT NULL) WITHOUT ROWID")
        db.execute("CREATE TABLE names(label TEXT NOT NULL, id INTEGER NOT NULL, kind INTEGER NOT NULL, PRIMARY KEY(label,id,kind)) WITHOUT ROWID")
        counts = [0, 0]
        rows = []
        with source.open("r", newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            missing = REQUIRED - set(reader.fieldnames or [])
            if missing:
                raise ValueError("Missing enriched CSV columns: " + ", ".join(sorted(missing)))
            for line_no, r in enumerate(reader, 2):
                coll = COLLECTIONS.get(r["collection"])
                if coll is None or r["archive_file"] != ARCHIVES[coll]:
                    raise ValueError(f"CSV line {line_no}: collection/archive mismatch")
                sha1, sha256, crc = r["sha1"].lower(), r["sha256"].lower(), r["crc32"].upper()
                if not SHA1.fullmatch(sha1) or not SHA256.fullmatch(sha256) or not CRC.fullmatch(crc):
                    raise ValueError(f"CSV line {line_no}: invalid checksum")
                path = r["archive_path"]
                if not path or path.startswith("/") or ".." in path.split("/"):
                    raise ValueError(f"CSV line {line_no}: unsafe archive path")
                size = int(r["size_bytes"])
                if size < 0:
                    raise ValueError(f"CSV line {line_no}: negative size")
                if r["metadata_status"] != "matched":
                    raise ValueError(f"CSV line {line_no}: metadata not matched ({r['metadata_status']})")
                rows.append((sha256, sha1, size, coll, r["filename"], path, crc,
                             r["midlet_name"], r["midlet_vendor"], r["midlet_version"], r["cldc"], r["midp"]))
                counts[coll] += 1
                if len(rows) >= 10000:
                    db.executemany("INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
                    rows.clear()
                if sum(counts) % 100000 == 0:
                    print(f"Loaded {sum(counts):,} enriched rows...", flush=True)
            if rows:
                db.executemany("INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        total = sum(counts)
        if a.expected_count and total != a.expected_count:
            raise ValueError(f"Expected {a.expected_count:,} rows, got {total:,}")
        db.execute("CREATE INDEX entries_hash ON entries(sha256,coll,path)")
        original_detail_count = load_details(db, details_path, a.max_original_paths)
        db.commit()

        next_data.mkdir(parents=True)
        try:
            rec_chunk, detail_chunk = [], []
            current, group, group_detail, content_id = None, None, None, 0
            source_masks = Counter()
            missing_details = 0
            name_buffer = []

            def flush_names():
                nonlocal name_buffer
                if name_buffer:
                    db.executemany("INSERT OR IGNORE INTO names VALUES (?,?,?)", name_buffer)
                    name_buffer = []

            def flush_file_chunk():
                nonlocal rec_chunk, detail_chunk
                if not rec_chunk:
                    return
                chunk = (content_id - 1) // a.record_chunk
                write_gzip(next_data / "records" / f"{chunk:04d}.json.gz", rec_chunk)
                write_gzip(next_data / "details" / f"{chunk:04d}.json.gz", detail_chunk)
                rec_chunk, detail_chunk = [], []

            def finish_group():
                nonlocal content_id, group, group_detail, missing_details
                if group is None:
                    return
                rec_chunk.append(group)
                detail_chunk.append(group_detail)
                db.execute("INSERT INTO lookup VALUES (?,?,?)", (group[0], group[1], content_id))
                mask = 0
                for source_item in group[3]:
                    mask |= 1 << source_item[0]
                source_masks[mask] += 1
                content_id += 1
                if content_id % a.record_chunk == 0:
                    flush_file_chunk()
                    if content_id % (a.record_chunk * 20) == 0:
                        print(f"Grouped {content_id:,} content hashes...", flush=True)
                if len(name_buffer) >= 10000:
                    flush_names()
                group, group_detail = None, None

            query = "SELECT * FROM entries ORDER BY sha256,coll,path"
            for sha256, sha1, size, coll, filename, path, crc, title, vendor, version, cldc, midp in db.execute(query):
                if sha256 != current:
                    finish_group()
                    current = sha256
                    group = [sha256, sha1, size, [], [title, vendor, version, cldc, midp]]
                    group_detail = []
                else:
                    if group[1] != sha1 or group[2] != size:
                        raise ValueError("Inconsistent hashes/size for " + sha256)
                    if coll == 1 or not group[4][0]:
                        group[4] = [title, vendor, version, cldc, midp]
                group[3].append([coll, filename, path, crc])
                rid = content_id
                name_buffer.append((filename.lower(), rid, 0))
                if title:
                    name_buffer.append((title.lower(), rid, 1))
                if vendor:
                    name_buffer.append((vendor.lower(), rid, 2))
                # A repeated content hash might have multiple paths in the same
                # collection; publish its manifest only once per collection.
                if not any(item[0] == coll for item in group_detail):
                    item = db.execute("SELECT payload FROM details WHERE sha256=? AND coll=?", (sha256, coll)).fetchone()
                    if item:
                        manifest, paths, all_path_count = json.loads(item[0])
                        group_detail.append([coll, manifest, paths, all_path_count])
                    else:
                        missing_details += 1
                        group_detail.append([coll, {}, [], 0])
            finish_group()
            flush_names()
            flush_file_chunk()
            db.commit()
            if missing_details:
                raise RuntimeError(f"Missing details for {missing_details:,} collection/content pairs")
            print(f"Grouped {content_id:,} distinct content hashes", flush=True)
            names_count = db.execute("SELECT COUNT(*) FROM names").fetchone()[0]

            # Exact SHA lookup in only 16 compressed prefix buckets per algorithm.
            for field in ("sha1", "sha256"):
                cursor = db.execute(f"SELECT {field},id FROM lookup ORDER BY {field}")
                prefix = None
                items = {}
                for h, rid in cursor:
                    pre = h[0]
                    if prefix is not None and pre != prefix:
                        write_gzip(next_data / field / f"{prefix}.json.gz", items)
                        items = {}
                    items[h] = rid
                    prefix = pre
                if prefix is not None:
                    write_gzip(next_data / field / f"{prefix}.json.gz", items)
                print(f"Created 16 compressed {field.upper()} prefix buckets", flush=True)

            # Exact CRC32 lookup, retaining all distinct matching content IDs.
            crc_cursor = db.execute("SELECT DISTINCT lower(e.crc), l.id FROM entries e "
                                    "JOIN lookup l ON e.sha256=l.sha256 ORDER BY lower(e.crc), l.id")
            crc_row = next(crc_cursor, None)
            for crc_prefix in "0123456789abcdef":
                crc_items = {}
                while crc_row is not None and crc_row[0][0] == crc_prefix:
                    crc_value, crc_id = crc_row
                    crc_items.setdefault(crc_value, []).append(crc_id)
                    crc_row = next(crc_cursor, None)
                write_gzip(next_data / "crc32" / f"{crc_prefix}.json.gz", crc_items)
            print("Created 16 compressed CRC32 prefix buckets", flush=True)

            # Query-selective 2/3-gram index: maps exact substrings to a shard
            # bitmap. A shard must contain ALL grams of a query to qualify.
            # Avoid loading millions of search rows into Python memory.
            per_shard = max(1, math.ceil(names_count / a.name_shards))
            shard, batch = 0, []
            masks = {2: {}, 3: {}}

            def write_name_shard():
                nonlocal batch, shard
                if not batch:
                    return
                write_gzip(next_data / "names" / f"{shard:03d}.json.gz", batch)
                bit = 1 << shard
                # Track ngrams once per shard; every matching term is still
                # checked exactly in the browser (no false results).
                seen2, seen3 = set(), set()
                for name, _, _ in batch:
                    chars = list(name)
                    seen2.update("".join(chars[i:i+2]) for i in range(len(chars)-1))
                    seen3.update("".join(chars[i:i+3]) for i in range(len(chars)-2))
                for gram in seen2:
                    masks[2][gram] = masks[2].get(gram, 0) | bit
                for gram in seen3:
                    masks[3][gram] = masks[3].get(gram, 0) | bit
                shard += 1
                batch = []
                if shard % 16 == 0:
                    print(f"Created {shard} search shards...", flush=True)

            for name, rid, kind in db.execute("SELECT label,id,kind FROM names ORDER BY label,id,kind"):
                batch.append([name, rid, kind])
                if len(batch) >= per_shard:
                    write_name_shard()
            write_name_shard()
            write_gzip(next_data / "names" / "grams.json.gz", {
                "2": {g: format(bits, "x") for g, bits in masks[2].items()},
                "3": {g: format(bits, "x") for g, bits in masks[3].items()},
            })

            manifest = {
                "schema_version": 4, "archive": "96x65pixels_j2me",
                "total_rows": total, "unique_files": content_id,
                "lite_rows": counts[0], "full_rows": counts[1],
                "shared_files": source_masks[3], "lite_only": source_masks[1], "full_only": source_masks[2],
                "record_chunk": a.record_chunk, "names_chunks": shard, "names_grams": "names/grams.json.gz",
                "search_terms": names_count, "name_index_version": 4, "max_original_paths": a.max_original_paths,
                "detail_records_input": original_detail_count,
                "schema": ["sha256", "sha1", "size", "sources", "primary_midlet_metadata"],
                "source_schema": ["collection_code", "filename", "archive_path", "crc32"],
                "collections": ["JARchiveLite v11", "JARchive v11"],
            }
            write_json(next_data / "manifest.json", manifest)
            stats = Counter()
            for file in next_data.rglob("*"):
                if file.is_file():
                    stats["files"] += 1
                    stats["bytes"] += file.stat().st_size
            total_mib = stats["bytes"] / 2**20
            report = {
                "rows": total, "unique_content": content_id, "search_terms": names_count,
                "files": stats["files"], "data_bytes": stats["bytes"], "data_mib": round(total_mib, 2),
                "shared": source_masks[3], "lite_only": source_masks[1], "full_only": source_masks[2],
                "details_imported": original_detail_count, "max_original_paths": a.max_original_paths,
            }
            report["files"] = stats["files"] + 1  # include build-summary.json itself
            report_file = next_data / "build-summary.json"
            for _ in range(5):
                previous = (report["data_bytes"], report["data_mib"])
                write_json(report_file, report)
                actual_bytes = stats["bytes"] + report_file.stat().st_size
                report["data_bytes"] = actual_bytes
                report["data_mib"] = round(actual_bytes / 2**20, 2)
                if previous == (report["data_bytes"], report["data_mib"]):
                    break
            write_json(report_file, report)
            print(f"STAGED: {content_id:,} unique files in {report['files']:,} files; {report['data_mib']:.1f} MiB")
            if report["data_mib"] > a.warn_mib:
                print(f"WARNING: Site data exceeds {a.warn_mib} MiB. Try --max-original-paths 0, or smaller metadata.")

            # Swap site data only after successful validation and generation.
            old_data = out / "data"
            backup = out / ".data-v4-previous"
            if backup.exists():
                raise RuntimeError(f"Previous backup exists at {backup}; move/remove it before swapping")
            if old_data.exists():
                old_data.rename(backup)
            try:
                next_data.rename(old_data)
            except Exception:
                if backup.exists() and not old_data.exists():
                    backup.rename(old_data)
                raise
            if backup.exists():
                shutil.rmtree(backup)
            print(f"COMPLETE: {total:,} entries, {content_id:,} distinct contents, {report['files']:,} data files")
            print(f"Output: {out / 'data'}")
        except BaseException:
            print(f"Build failed; staging folder (if present): {next_data}")
            raise
        finally:
            db.close()


if __name__ == "__main__":
    main()
