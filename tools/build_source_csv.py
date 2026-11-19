#!/usr/bin/env python3
"""Rebuild the v2 source-row CSV from independently hashed Full/Lite/Mini JARs.

Does not read any published release or repository data/.
"""

import argparse
import csv
import gzip
import io
from pathlib import Path
import sqlite3
import sys

COLUMNS = ("collection", "filename", "archive_path", "size_bytes", "crc32",
           "sha1", "sha256", "archive_file")
COLLECTIONS = {
    "lite": "JARchiveLite v11",
    "full": "JARchive v11",
}
MINI_COLLECTION = "96x65pixels J2ME mini"


def readonly(path):
    if not path.is_file():
        raise SystemExit(f"Database not found: {path}")
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)


def require_integrity(conn, label):
    result = conn.execute("PRAGMA quick_check").fetchone()[0]
    if result != "ok":
        raise SystemExit(f"{label} integrity check failed: {result}")


def audit(v1, mini):
    v1_stats = v1.execute("""
        SELECT COUNT(*), COUNT(sha256), COUNT(manifest_json), COUNT(DISTINCT sha256),
               SUM(CASE WHEN actual_size != declared_size OR
                         UPPER(actual_crc32) != UPPER(declared_crc32)
                        THEN 1 ELSE 0 END)
        FROM members
    """).fetchone()
    mini_stats = mini.execute("""
        SELECT COUNT(*), COUNT(sha256), COUNT(manifest_json), COUNT(DISTINCT sha256),
               SUM(CASE WHEN actual_size != declared_size OR
                         UPPER(actual_crc32) != UPPER(declared_crc32)
                        THEN 1 ELSE 0 END)
        FROM mini_members
    """).fetchone()
    v1_issues = v1.execute("SELECT COUNT(*) FROM member_issues").fetchone()[0]
    mini_issues = mini.execute("SELECT COUNT(*) FROM mini_issues").fetchone()[0]
    print("v1 counts (rows, hashed, manifests, unique, mismatches):", v1_stats)
    print("Mini counts (rows, hashed, manifests, unique, mismatches):", mini_stats)
    print("Issue counts:", v1_issues, mini_issues)
    if v1_stats != (816215, 816215, 816215, 620287, 0):
        raise SystemExit("Unexpected v1 audit result: CSV not generated")
    if mini_stats != (225867, 225867, 225867, 225867, 0):
        raise SystemExit("Unexpected Mini audit result: CSV not generated")
    if v1_issues or mini_issues:
        raise SystemExit("Recorded problems exist: CSV not generated")
    require_integrity(v1, "v1")
    require_integrity(mini, "Mini")


def check_hash(h, chars, label):
    if (not isinstance(h, str) or len(h) != chars
            or any(c not in "0123456789abcdefABCDEF" for c in h)):
        raise ValueError(f"Invalid {label}: {h!r}")
    return h.lower()


def source_row(collection, filename_path, size, crc, sha1, sha256, archive_file):
    if not isinstance(filename_path, str) or not filename_path:
        raise ValueError("Missing archive member path")
    if not isinstance(archive_file, str) or not archive_file:
        raise ValueError("Missing archive filename")
    sha1 = check_hash(sha1, 40, "SHA-1")
    sha256 = check_hash(sha256, 64, "SHA-256")
    crc = check_hash(crc, 8, "CRC32").upper()
    if size is None or int(size) < 0:
        raise ValueError("Invalid size")
    return (collection, filename_path.rsplit("/", 1)[-1], filename_path,
            str(int(size)), crc, sha1, sha256, archive_file)


def write_independent(out, v1, mini):
    print("Loading v1 SHA-256 set for independent deduplication...", flush=True)
    known_v1 = {h.lower() for (h,) in v1.execute("SELECT sha256 FROM members")}
    if len(known_v1) != 620287:
        raise SystemExit("Unexpected v1 unique count")
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        raise SystemExit(f"Destination already exists; not overwriting: {out}")
    partial = out.with_name(out.name + ".partial")
    if partial.exists():
        raise SystemExit(f"Remove or inspect previous incomplete output first: {partial}")
    base_rows = mini_only_rows = 0
    try:
        with partial.open("wb") as raw:
            with gzip.GzipFile(fileobj=raw, filename="", mode="wb", mtime=0,
                               compresslevel=6) as gz:
                with io.TextIOWrapper(gz, encoding="utf-8", newline="") as text:
                    writer = csv.writer(text, lineterminator="\n")
                    writer.writerow(COLUMNS)
                    for collection, member_path, size, crc, sha1, sha256, archive_name in v1.execute("""
                        SELECT collection, member_path, actual_size, actual_crc32,
                               sha1, sha256, archive_name
                        FROM members ORDER BY id
                    """):
                        writer.writerow(source_row(COLLECTIONS[collection], member_path,
                                                    size, crc, sha1, sha256, archive_name))
                        base_rows += 1
                    for package_name, member_path, size, crc, sha1, sha256 in mini.execute("""
                        SELECT package_name, member_path, actual_size, actual_crc32,
                               sha1, sha256
                        FROM mini_members ORDER BY id
                    """):
                        if sha256.lower() in known_v1:
                            continue
                        writer.writerow(source_row(MINI_COLLECTION, member_path,
                                                    size, crc, sha1, sha256, package_name))
                        mini_only_rows += 1
        if (base_rows, mini_only_rows) != (816215, 1428):
            raise ValueError(f"Unexpected generated source row counts: "
                             f"{base_rows} + {mini_only_rows}")
        partial.replace(out)
    except BaseException:
        print(f"Generation interrupted; inspect partial file at {partial}",
              file=sys.stderr)
        raise
    print(f"Generated: {out}")
    print(f"Rows: {base_rows:,} v1 + {mini_only_rows:,} Mini-only "
          f"= {base_rows + mini_only_rows:,}")
    print(f"Compressed size: {out.stat().st_size / 1024**2:.2f} MiB")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_base = Path.home() / "j2me-independent"
    parser.add_argument("--base", type=Path, default=default_base)
    args = parser.parse_args()
    base = args.base.expanduser().resolve()
    out = base / "independent-output/jarchive-combined-verified-v2.csv.gz"
    with readonly(base / "working/v1-inventory.sqlite") as v1:
        with readonly(base / "working/mini-inventory.sqlite") as mini:
            audit(v1, mini)
            write_independent(out, v1, mini)
    return 0


if __name__ == "__main__":
    sys.exit(main())
