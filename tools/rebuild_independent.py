#!/usr/bin/env python3
"""Independently rebuild the v2 catalogue and website data from original archives.

Run from this repository: python3 tools/rebuild_independent.py
Inputs in ~/Downloads: JARchiveLite_v11.7z, JARchive_v11.7z,
96x65pixels_j2me_mini.zip (containing nine Mini 7z packages).
Outputs under ~/j2me-independent-rebuild/independent-output/.
No published CSV, historical reference index, or existing data/ is read.
Resume by running the command again. See docs/REBUILD.md.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

import index_mini as mini

HOME = Path.home()
DOWNLOADS = HOME / "Downloads"
# Keep large extracted files and newly built data outside the checkout.
# Override with J2ME_REBUILD_HOME=/path/to/empty-or-resumable-directory.
BASE = Path(os.environ.get(
    "J2ME_REBUILD_HOME", str(HOME / "j2me-independent-rebuild")
)).expanduser().resolve()
WORK = BASE / "working"
STAGING = BASE / "staging"
REPO = Path(__file__).resolve().parents[1]

V1_ARCHIVES = (
    ("lite", "JARchiveLite_v11.7z", 198184),
    ("full", "JARchive_v11.7z", 618031),
)
V1_DB = WORK / "v1-inventory.sqlite"
MINI_DB = WORK / "mini-inventory.sqlite"


def report(message: str) -> None:
    print(message, flush=True)


def run(*args: object) -> None:
    cmd = [str(x) for x in args]
    report("$ " + " ".join(cmd))
    subprocess.run(cmd, check=True)


def inputs_check() -> None:
    required = [DOWNLOADS / name for _, name, _ in V1_ARCHIVES]
    required.append(DOWNLOADS / "96x65pixels_j2me_mini.zip")
    missing = [p for p in required if not p.is_file()]
    if missing:
        raise RuntimeError("Missing source archive(s):\n" + "\n".join(str(p) for p in missing))
    if not shutil.which("7z"):
        raise RuntimeError("Missing 7z: install with sudo apt install 7zip")
    if BASE == REPO or BASE.is_relative_to(REPO):
        raise RuntimeError("Workspace must be outside the repository: set J2ME_REBUILD_HOME")
    BASE.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    report("Original Full, Lite and Mini archives found in ~/Downloads")


def v1_schema(conn: sqlite3.Connection) -> None:
    # Fail safely if pointed at a legacy manual rebuild DB. Its ``members``
    # table did not enforce UNIQUE(collection, member_path), and INSERT OR
    # IGNORE would silently insert duplicate entries instead of resuming.
    has_members = conn.execute("""SELECT 1 FROM sqlite_master
                                  WHERE type='table' AND name='members'""").fetchone()
    if has_members:
        unique_path_key = False
        for row in conn.execute("PRAGMA index_list('members')"):
            if not row[2]:
                continue
            cols = [c[2] for c in conn.execute(
                'PRAGMA index_info("' + row[1].replace('"', '""') + '")'
            )]
            if cols == ['collection', 'member_path']:
                unique_path_key = True
                break
        if not unique_path_key:
            raise RuntimeError(
                "Existing v1 database uses the old, non-unique members schema. "
                "Refusing to modify it. Choose a clean J2ME_REBUILD_HOME "
                "directory instead."
            )
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS members (
            id INTEGER PRIMARY KEY,
            collection TEXT NOT NULL,
            archive_name TEXT NOT NULL,
            member_path TEXT NOT NULL,
            declared_size INTEGER NOT NULL,
            declared_crc32 TEXT,
            actual_size INTEGER,
            actual_crc32 TEXT,
            sha1 TEXT,
            sha256 TEXT,
            manifest_json TEXT,
            UNIQUE(collection, member_path)
        );
        CREATE TABLE IF NOT EXISTS member_issues (
            member_id INTEGER PRIMARY KEY,
            issue TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_member_collection_path
        ON members(collection, member_path);
    """)
    conn.commit()


def v1_headers(conn: sqlite3.Connection, collection: str, archive_name: str,
               expected: dict[str, tuple[int, str]], count: int) -> None:
    if len(expected) != count:
        raise RuntimeError(f"{archive_name}: expected {count:,} JARs, found {len(expected):,}")
    with conn:
        conn.executemany("""
            INSERT OR IGNORE INTO members
            (collection, archive_name, member_path, declared_size, declared_crc32)
            VALUES (?, ?, ?, ?, ?)
        """, ((collection, archive_name, path, size, crc)
               for path, (size, crc) in expected.items()))

    rows = conn.execute("""
        SELECT member_path, archive_name, declared_size, declared_crc32
        FROM members WHERE collection=?
    """, (collection,))
    seen = 0
    for path, saved_archive, size, crc in rows:
        seen += 1
        if saved_archive != archive_name or expected.get(path) != (size, crc):
            raise RuntimeError(f"Previously stored archive header disagrees: {path!r}")
    if seen != count:
        raise RuntimeError(f"Unexpected number of stored {collection} paths: {seen}")


def staging_files(root: Path) -> dict[str, Path]:
    # The shared Mini helper handles undecodable Linux path bytes correctly.
    return mini.staged_file_paths(root)


def v1_extract(archive: Path, collection: str,
               expected: dict[str, tuple[int, str]],
               overlong: dict[str, tuple[int, str]]) -> tuple[Path, dict[str, Path]]:
    root = STAGING / collection
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise RuntimeError(f"Refusing symlink staging directory: {root}")
    intended = {name: size for name, (size, _) in expected.items()
                if name not in overlong}
    actual_paths = staging_files(root)
    actual = {path: p.stat().st_size for path, p in actual_paths.items()}
    if actual != intended:
        if actual:
            # Partial data may have been left behind on interruption. 7z will
            # overwrite the same paths; we verify all paths and sizes afterward.
            report(f"Resuming/re-extracting incomplete {collection} staging...")
        else:
            report(f"Extracting {collection}: {len(intended):,} regular JARs...")
        argv = ["7z", "x", "-y", "-bb0", "-spd"]
        argv.extend("-x!" + path for path in overlong)
        argv.extend([f"-o{root}", str(archive)])
        run(*argv)
        actual_paths = staging_files(root)
        actual = {path: p.stat().st_size for path, p in actual_paths.items()}
        if actual != intended:
            missing = len(intended.keys() - actual.keys())
            extra = len(actual.keys() - intended.keys())
            bad_sizes = sum(actual[p] != intended[p] for p in intended.keys() & actual.keys())
            raise RuntimeError(f"{collection} extraction incomplete: "
                               f"missing={missing}, extra={extra}, bad_sizes={bad_sizes}; "
                               "staging preserved")
    report(f"Extraction verified: {len(actual_paths):,} {collection} files")
    return root, actual_paths


def stream_overlong(archive: Path, member: str) -> Path:
    fd, name = tempfile.mkstemp(prefix="j2me-overlong-", suffix=".jar", dir=WORK)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "wb") as dest:
            result = subprocess.run(
                ["7z", "x", "-so", "-spd", str(archive), member],
                stdout=dest, stderr=subprocess.PIPE)
        if result.returncode != 0:
            raise RuntimeError("Failed to extract overlong archive member: "
                               + result.stderr.decode("utf-8", errors="replace")[-500:])
        return tmp
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def v1_hash(conn: sqlite3.Connection, collection: str, archive: Path,
            paths: dict[str, Path], overlong: dict[str, tuple[int, str]]) -> None:
    remaining = conn.execute("""
        SELECT id, member_path, declared_size, declared_crc32
        FROM members WHERE collection=? AND sha256 IS NULL ORDER BY id
    """, (collection,)).fetchall()
    report(f"Hashing {len(remaining):,} remaining {collection} JARs")
    batch: list[tuple] = []
    counter = 0

    def save() -> None:
        if not batch:
            return
        with conn:
            conn.executemany("""
                UPDATE members
                SET actual_size=?, actual_crc32=?, sha1=?, sha256=?, manifest_json=?
                WHERE id=?
            """, batch)
            conn.executemany("DELETE FROM member_issues WHERE member_id=?",
                             ((r[-1],) for r in batch))
        batch.clear()

    try:
        for member_id, member, expected_size, expected_crc in remaining:
            temp = None
            try:
                if member in overlong:
                    temp = stream_overlong(archive, member)
                    path = temp
                else:
                    path = paths[member]
                    if path.is_symlink() or not path.is_file():
                        raise RuntimeError(f"Unexpected staged file: {member!r}")
                size, crc, sha1, sha256 = mini.hashes(path)
                if (size, crc) != (expected_size, expected_crc):
                    raise RuntimeError(
                        f"Archive CRC32/size mismatch: {collection} {member!r}, "
                        f"actual {size}/{crc} vs declared {expected_size}/{expected_crc}")
                manifest, issue = mini.manifest_from_jar(path)
                if issue or not manifest:
                    raise RuntimeError(f"JAR manifest unavailable: {member!r}: {issue}")
                batch.append((size, crc, sha1, sha256, manifest, member_id))
                counter += 1
                if len(batch) >= 250:
                    save()
                if counter % 5000 == 0:
                    report(f"  {collection}: {counter:,}/{len(remaining):,} newly hashed")
            finally:
                if temp is not None:
                    temp.unlink(missing_ok=True)
        save()
    except BaseException:
        save()
        raise


def v1_audit(conn: sqlite3.Connection, collection: str, expected: int) -> None:
    total, hashed, manifests, differences = conn.execute("""
        SELECT COUNT(*), COUNT(sha256), COUNT(manifest_json),
               COALESCE(SUM(CASE WHEN actual_size IS NOT NULL AND
                 (actual_size != declared_size OR
                  UPPER(actual_crc32) != UPPER(declared_crc32))
                  THEN 1 ELSE 0 END), 0)
        FROM members WHERE collection=?
    """, (collection,)).fetchone()
    issues = conn.execute("""
        SELECT COUNT(*) FROM member_issues i JOIN members m ON m.id=i.member_id
        WHERE m.collection=?
    """, (collection,)).fetchone()[0]
    report(f"{collection}: rows={total:,}, hashed={hashed:,}, "
           f"manifests={manifests:,}, mismatches={differences}, issues={issues}")
    if (total, hashed, manifests, differences, issues) != (
        expected, expected, expected, 0, 0
    ):
        raise RuntimeError(f"Incomplete {collection} reconstruction; staging preserved")


def rebuild_v1() -> None:
    report("\n=== Independently rebuild original Full + Lite ===")
    with sqlite3.connect(V1_DB) as con:
        v1_schema(con)
        for collection, archive_name, expected_count in V1_ARCHIVES:
            archive = DOWNLOADS / archive_name
            report(f"\n=== {archive_name} ===")
            expected, overlong = mini.inspect_7z(archive)
            v1_headers(con, collection, archive_name, expected, expected_count)
            pending = con.execute(
                "SELECT COUNT(*) FROM members WHERE collection=? AND sha256 IS NULL",
                (collection,)).fetchone()[0]
            if pending:
                root, paths = v1_extract(archive, collection, expected, overlong)
                v1_hash(con, collection, archive, paths, overlong)
                v1_audit(con, collection, expected_count)
                shutil.rmtree(root)
                report(f"Removed verified {collection} staging")
            else:
                v1_audit(con, collection, expected_count)
        counts = con.execute("""
            SELECT COUNT(*), COUNT(sha256), COUNT(manifest_json), COUNT(DISTINCT sha256)
            FROM members
        """).fetchone()
        integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        if counts != (816215, 816215, 816215, 620287) or integrity != "ok":
            raise RuntimeError(f"Unexpected completed v1 audit: {counts}, {integrity}")
        report(f"PASS: Original v1 independently rebuilt, {counts[3]:,} unique SHA-256")


def rebuild_mini() -> None:
    report("\n=== Independently rebuild Mini ===")
    with sqlite3.connect(MINI_DB) as conn:
        mini.ensure_schema(conn)
    mini.BASE = BASE
    mini.SOURCE_ZIP = DOWNLOADS / "96x65pixels_j2me_mini.zip"
    mini.DB_FILE = MINI_DB
    mini.PACKAGES_DIR = BASE / "mini-packages"
    mini.STAGING_DIR = STAGING / "mini"
    mini.main()


def check_source() -> None:
    # Build tools and static files come from THIS checkout. Published data/
    # is intentionally neither read nor copied by the rebuild.
    for path in ("tools/build_site.py", "tools/build_folder_groups.py",
                 "tools/build_search_summaries.py", "tools/build_mini_downloads.py",
                 "tools/check_folder_index.py", "tools/check_full_index.py",
                 "index.html", "jarchive_download.py", "assets", "html"):
        if not (REPO / path).exists():
            raise RuntimeError(f"Missing repository source: {REPO / path}")
    report(f"Using local website/build source: {REPO}")


def finish_site() -> None:
    report("\n=== Generate combined catalogue and website data ===")
    source_csv = BASE / "independent-output/jarchive-combined-verified-v2.csv.gz"
    enriched = BASE / "independent-output/enrichment-v2"
    core = BASE / "independent-output/site-data-v2"
    preview = BASE / "independent-output/website-preview"
    here = Path(__file__).resolve().parent
    if not source_csv.exists():
        run(sys.executable, here / "build_source_csv.py", "--base", BASE)
    if not enriched.exists():
        run(sys.executable, here / "build_enrichment.py", "--base", BASE)
    if not (core / "manifest.json").exists():
        run(sys.executable, REPO / "tools/build_site.py",
            "--input", enriched / "jarchive-enriched.csv",
            "--details", enriched / "jarchive-enriched-details.jsonl.gz",
            "--out", core,
            "--expected-count", 817643,
            "--expected-unique", 621715,
            "--name-shards", 1024,
            "--name-layout", "published")
    run(sys.executable, REPO / "tools/check_full_index.py", "--data", core)
    if not preview.exists():
        # Use repo source files only, never its data files.
        import assemble_site as assemble
        assemble.BASE = BASE
        assemble.OUTPUT = BASE / "independent-output"
        assemble.SOURCE_DATA = core
        assemble.MINI_DB = MINI_DB
        assemble.COMBINED_GZIP = source_csv
        assemble.REPO = REPO
        assemble.DEST = preview
        assemble.main()
    run(sys.executable, REPO / "tools/check_folder_index.py", "--repo", preview,
        "--require-folders")
    run(sys.executable, REPO / "tools/check_full_index.py", "--data", preview / "data")
    report("\nPASS: Entire site independently rebuilt!")
    report(f"Website: {preview}")
    report("Launch: python3 -m http.server --directory '" + str(preview) + "' 8001")


def main() -> None:
    inputs_check()
    check_source()
    rebuild_v1()
    rebuild_mini()
    finish_site()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError, sqlite3.Error) as exc:
        print(f"\nSTOPPED: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
