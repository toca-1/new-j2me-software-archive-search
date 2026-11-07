#!/usr/bin/env python3
"""Build the static searchable JARchive v11 / JARchiveLite v11 site.

Input: jarchive-combined-verified.csv from jarchive_merge_verify_v2.py.
Output: compact GitHub Pages data shards, source-aware and content-deduplicated.
No extra Python packages. Original CSV and archives remain untouched.
"""
from __future__ import annotations
import argparse, csv, gzip, hashlib, json, re, shutil, sqlite3, tempfile
from pathlib import Path

SHA1 = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
EXPECTED = 816215
CHUNK = 1024
NAMES_CHUNK = 32768
COLLS = {"JARchiveLite v11": 0, "JARchive v11": 1}
FILES = {0: "JARchiveLite_v11.7z", 1: "JARchive_v11.7z"}
FIELDS = ["collection", "filename", "archive_path", "size_bytes", "crc32", "sha1", "sha256", "archive_file"]


def dump_json(dst, obj):
    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def dump_gz(dst, obj):
    dst.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with dst.open("wb") as f:
        f.write(gzip.compress(payload, compresslevel=9, mtime=0))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path, help="Website directory, containing index.html")
    p.add_argument("--expected-count", type=int, default=EXPECTED)
    a = p.parse_args()
    source = a.input.expanduser().resolve(strict=True)
    out = a.out.expanduser().resolve()
    if not (out / "index.html").exists():
        p.error("--out must point to the unzipped site folder containing index.html")
    with tempfile.TemporaryDirectory(prefix="jarchive-build-") as t:
        db = sqlite3.connect(str(Path(t) / "work.sqlite"))
        db.execute("PRAGMA synchronous=OFF")
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("CREATE TABLE entries(sha256 TEXT NOT NULL, sha1 TEXT NOT NULL, size INTEGER NOT NULL, coll INTEGER NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL, crc TEXT NOT NULL)")
        counts = [0, 0]
        with source.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            missing = set(FIELDS) - set(reader.fieldnames or [])
            if missing:
                raise ValueError("Missing CSV columns: " + ", ".join(sorted(missing)))
            pending = []
            for n, row in enumerate(reader, 2):
                coll = COLLS.get(row["collection"])
                if coll is None or row["archive_file"] != FILES[coll]:
                    raise ValueError(f"Row {n}: archive/collection mismatch")
                h1, h256 = row["sha1"].lower(), row["sha256"].lower()
                if not SHA1.fullmatch(h1) or not SHA256.fullmatch(h256):
                    raise ValueError(f"Row {n}: invalid hash")
                filename, path = row["filename"], row["archive_path"]
                if not filename or not path or path.startswith("/") or any(x == ".." for x in path.split("/")):
                    raise ValueError(f"Row {n}: invalid archive path")
                size = int(row["size_bytes"])
                if size < 0:
                    raise ValueError(f"Row {n}: negative size")
                crc = row["crc32"].upper()
                if len(crc) != 8 or not all(ch in "0123456789ABCDEF" for ch in crc):
                    raise ValueError(f"Row {n}: invalid CRC")
                pending.append((h256, h1, size, coll, filename, path, crc))
                counts[coll] += 1
                if len(pending) == 10000:
                    db.executemany("INSERT INTO entries VALUES (?,?,?,?,?,?,?)", pending)
                    pending.clear()
                    if sum(counts) % 100000 == 0:
                        print(f"Loaded {sum(counts):,} rows...", flush=True)
            if pending:
                db.executemany("INSERT INTO entries VALUES (?,?,?,?,?,?,?)", pending)
        total = sum(counts)
        if a.expected_count and total != a.expected_count:
            raise ValueError(f"Wrong number of rows: {total:,}, expected {a.expected_count:,}")
        db.execute("CREATE INDEX by_hash ON entries(sha256)")
        db.execute("CREATE TABLE lookup(sha256 TEXT PRIMARY KEY, sha1 TEXT NOT NULL, id INTEGER NOT NULL)")
        data = out / "data"
        if data.exists():
            shutil.rmtree(data)
        records = []
        previous = None
        next_id = 0
        source_masks = [0, 0, 0, 0]
        def flush(group):
            nonlocal next_id, records
            if not group:
                return
            records.append(group)
            collmask = 0
            for entry in group[3]:
                collmask |= 1 << entry[0]
            source_masks[collmask] += 1
            db.execute("INSERT INTO lookup VALUES(?,?,?)", (group[0], group[1], next_id))
            next_id += 1
            if len(records) == CHUNK:
                dump_json(data / "records" / f"{(next_id-1)//CHUNK:04d}.json", records)
                records = []
        group = None
        # Records are [sha256, sha1, size, [[archive_code, filename, path, crc32], ...]].
        for h256, h1, size, coll, filename, path, crc in db.execute("SELECT * FROM entries ORDER BY sha256,coll,path"):
            if h256 != previous:
                flush(group)
                group = [h256, h1, size, []]
                previous = h256
            elif group[1] != h1 or group[2] != size:
                raise ValueError("Same SHA-256 mapped to inconsistent SHA-1 or file size: " + h256)
            group[3].append([coll, filename, path, crc])
        flush(group)
        if records:
            dump_json(data / "records" / f"{(next_id-1)//CHUNK:04d}.json", records)
        db.commit()
        print(f"Grouped into {next_id:,} unique content hashes", flush=True)
        db.execute("CREATE INDEX by_sha1 ON lookup(sha1)")
        for field, col in (("sha1", "sha1"), ("sha256", "sha256")):
            bucket, prefix = {}, None
            for hashval, ident in db.execute(f"SELECT {col},id FROM lookup ORDER BY {col}"):
                pre = hashval[:2]
                if prefix is not None and pre != prefix:
                    dump_json(data / field / f"{prefix}.json", bucket)
                    bucket = {}
                bucket[hashval] = ident
                prefix = pre
            if prefix is not None:
                dump_json(data / field / f"{prefix}.json", bucket)
            print(f"Created {field.upper()} lookup shards", flush=True)
        # Names include all original names, even for shared SHA-256 contents.
        rows, nameno, nidx = [], 0, 0
        for name, ident in db.execute("SELECT e.filename,l.id FROM entries e JOIN lookup l ON e.sha256=l.sha256"):
            rows.append([name.casefold(), ident])
            nameno += 1
            if len(rows) >= NAMES_CHUNK:
                dump_gz(data / "names" / f"{nidx:03d}.json.gz", rows)
                nidx += 1
                rows = []
        if rows:
            dump_gz(data / "names" / f"{nidx:03d}.json.gz", rows)
            nidx += 1
        manifest = {"archive":"96x65pixels_j2me", "total_rows":total,
                    "unique_files":next_id, "lite_rows":counts[0], "full_rows":counts[1],
                    "shared_files":source_masks[3], "lite_only":source_masks[1], "full_only":source_masks[2],
                    "record_chunk": CHUNK, "names_chunks": nidx, "name_chunk": NAMES_CHUNK,
                    "schema":["sha256","sha1","size","sources"],
                    "source_schema":["collection_code","filename","archive_path","crc32"],
                    "collections":["JARchiveLite v11", "JARchive v11"]}
        dump_json(data / "manifest.json", manifest)
        total_bytes = sum(x.stat().st_size for x in data.rglob("*") if x.is_file())
        print(f"COMPLETE: {total:,} rows, {next_id:,} unique hashes, {nidx} filename shards, {total_bytes/1048576:.1f} MiB site data")
        print(f"Lite only: {source_masks[1]:,}  Full only: {source_masks[2]:,}  Shared: {source_masks[3]:,}")
        print(f"Upload this website folder (including data/) to the GitHub Pages repository.")
        db.close()

if __name__ == "__main__":
    main()
