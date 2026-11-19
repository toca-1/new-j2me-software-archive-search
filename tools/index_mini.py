#!/usr/bin/env python3
"""Independently inventory, extract, hash and audit the nine J2ME Mini packages.

Reads ONLY the original Mini ZIP, its nested 7z packages and the local SQLite
inventory. Does not use a published release CSV or a repository data tree.

Called by rebuild_independent.py. Can be restarted safely: completed rows
are retained, and staged JARs are deleted only after verification.
"""

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path

HOME = Path.home()
BASE = HOME / "j2me-independent-rebuild"
SOURCE_ZIP = HOME / "Downloads/96x65pixels_j2me_mini.zip"
DB_FILE = BASE / "working" / "mini-inventory.sqlite"
PACKAGES_DIR = BASE / "mini-packages"
STAGING_DIR = BASE / "staging" / "mini"
PACKAGE_NAMES = (
    "A-B.7z", "#.7z", "C-D.7z", "E-G.7z", "H-L.7z",
    "M-O.7z", "P-R.7z", "S.7z", "T-Z.7z",
)
EXPECTED_TOTAL = 225867
CHUNK = 1024 * 1024
BATCH = 250
MAX_MANIFEST = 2 * 1024 * 1024


def notice(message):
    print(message, flush=True)


def manifest_from_jar(path):
    """Read main JAR manifest attributes, including folded UTF-8 lines."""
    try:
        with zipfile.ZipFile(path) as jar:
            entry = next(
                (item for item in jar.infolist()
                 if item.filename.replace("\\", "/").strip("/").lower()
                 == "meta-inf/manifest.mf"),
                None,
            )
            if entry is None:
                return None, "missing_manifest"
            if entry.file_size > MAX_MANIFEST:
                return None, "manifest_too_large"
            with jar.open(entry) as file:
                raw = file.read(MAX_MANIFEST + 1)
            if len(raw) > MAX_MANIFEST:
                return None, "manifest_too_large"

        raw = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        lines = []
        for line in raw.split(b"\n"):
            if not line:
                break
            if line.startswith(b" ") and lines:
                lines[-1] += line[1:]
            else:
                lines.append(line)
        fields = {}
        for line in lines:
            if b": " in line:
                key, val = line.split(b": ", 1)
                fields[key.decode("ascii", errors="replace")] = val.decode(
                    "utf-8", errors="replace"
                )
        return json.dumps(fields, ensure_ascii=False), None
    except Exception as exc:
        return None, f"manifest_error: {type(exc).__name__}: {str(exc)[:180]}"


def hashes(path):
    sha1, sha256 = hashlib.sha1(), hashlib.sha256()
    size, crc = 0, 0
    with path.open("rb") as file:
        while chunk := file.read(CHUNK):
            size += len(chunk)
            crc = zlib.crc32(chunk, crc)
            sha1.update(chunk)
            sha256.update(chunk)
    return size, f"{crc:08X}", sha1.hexdigest(), sha256.hexdigest()


def inspect_7z(package_path):
    """Read 7z headers; do not trust paths before safety checks."""
    process = subprocess.Popen(
        ["7z", "l", "-slt", str(package_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    current, inside = {}, False
    entries = {}
    overlong = {}
    problems = []

    def inspect(entry):
        path = entry.get("Path", "")
        if entry.get("Attributes", "").startswith("D"):
            return
        if not path:
            return
        parts = path.split("/")
        if (path.startswith("/") or "\\" in path or "\x00" in path
                or any(p in ("", ".", "..") for p in parts)):
            problems.append(f"Unsafe member path: {path!r}")
            return
        if not path.lower().endswith(".jar"):
            problems.append(f"Unexpected non-JAR file: {path!r}")
            return
        if path in entries:
            problems.append(f"Duplicate member path: {path!r}")
            return
        try:
            size = int(entry["Size"])
            crc = entry["CRC"].upper()
            if len(crc) != 8 or any(c not in "0123456789ABCDEF" for c in crc):
                raise ValueError("invalid CRC32")
            if size < 0:
                raise ValueError("negative size")
        except (KeyError, ValueError) as exc:
            problems.append(f"Invalid header {path!r}: {exc}")
            return
        entries[path] = (size, crc)
        if any(len(part.encode("utf-8")) > 255 for part in parts):
            overlong[path] = (size, crc)

    assert process.stdout is not None
    for raw in process.stdout:
        line = raw.rstrip("\r\n")
        if line == "----------":
            inside = True
            continue
        if not inside:
            continue
        if not line:
            if current:
                inspect(current)
                current = {}
        elif " = " in line:
            key, value = line.split(" = ", 1)
            current[key] = value
    if current:
        inspect(current)
    code = process.wait()
    if code:
        problems.append(f"7z listing failed with exit code {code}")
    if problems:
        for issue in problems[:10]:
            notice("  ERROR: " + issue)
        raise RuntimeError(f"{len(problems)} invalid archive entries in {package_path.name}")
    if not entries:
        raise RuntimeError(f"No JAR entries in {package_path.name}")
    return entries, overlong


def get_package(zip_file, info, name):
    """Reuse an existing extracted package after checking its length and ZIP CRC."""
    PACKAGES_DIR.mkdir(parents=True, exist_ok=True)
    final = PACKAGES_DIR / name
    if final.exists():
        if not final.is_file() or final.is_symlink() or final.stat().st_size != info.file_size:
            raise RuntimeError(f"Existing package has wrong type/size: {final}")
        checksum = 0
        with final.open("rb") as file:
            while block := file.read(CHUNK):
                checksum = zlib.crc32(block, checksum)
        if checksum != info.CRC:
            raise RuntimeError(f"Existing package fails original ZIP CRC32: {final}")
        notice(f"Reusing ZIP-CRC-verified {name}")
        return final

    temporary = final.with_name(final.name + ".partial")
    if temporary.exists():
        raise RuntimeError(f"Incomplete package file exists; inspect it: {temporary}")
    notice(f"Extracting package {name} from the original Mini ZIP...")
    try:
        with zip_file.open(info) as src, temporary.open("xb") as dst:
            shutil.copyfileobj(src, dst, CHUNK)
        if temporary.stat().st_size != info.file_size:
            raise RuntimeError(f"Incorrect extracted package size for {name}")
        temporary.rename(final)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return final


def ensure_schema(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS mini_members (
        id INTEGER PRIMARY KEY,
        package_name TEXT NOT NULL,
        member_path TEXT NOT NULL,
        declared_size INTEGER NOT NULL,
        declared_crc32 TEXT NOT NULL,
        actual_size INTEGER,
        actual_crc32 TEXT,
        sha1 TEXT,
        sha256 TEXT,
        manifest_json TEXT,
        UNIQUE(package_name, member_path)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS mini_issues (
        member_id INTEGER PRIMARY KEY,
        issue TEXT NOT NULL
    )""")
    conn.commit()


def record_headers(conn, name, expected):
    with conn:
        conn.executemany(
            """INSERT OR IGNORE INTO mini_members
            (package_name, member_path, declared_size, declared_crc32)
            VALUES (?, ?, ?, ?)""",
            ((name, path, size, crc) for path, (size, crc) in expected.items()),
        )
    # Strictly ensure any pre-existing rows refer to the same input bytes.
    saved = {
        path: (size, crc.upper())
        for path, size, crc in conn.execute(
            """SELECT member_path, declared_size, declared_crc32
            FROM mini_members WHERE package_name=?""", (name,)
        )
    }
    if saved != expected:
        raise RuntimeError(f"SQLite archive headers differ from source for {name}")


def staged_file_paths(root):
    """Map the replacement-decoded 7z listing names to actual OS paths.

    7z listing stdout uses errors="replace" but Linux filenames containing
    undecodable bytes use surrogateescape. Keep actual paths for reading.
    """
    files = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        for sub in dirs:
            p = Path(directory) / sub
            if p.is_symlink():
                raise RuntimeError(f"Unexpected symlink in staging: {p}")
        for name in names:
            p = Path(directory) / name
            if p.is_symlink() or not p.is_file():
                raise RuntimeError(f"Unexpected staged file type: {p}")
            raw_relative = os.fsencode(p.relative_to(root).as_posix())
            canonical = raw_relative.decode("utf-8", errors="replace")
            if canonical in files:
                raise RuntimeError(f"Ambiguous staged filename: {canonical!r}")
            files[canonical] = p
    return files


def stage_listing(root):
    """Return sizes keyed by names as printed by 7z l -slt."""
    return {name: p.stat().st_size for name, p in staged_file_paths(root).items()}


def extract_and_verify(package_path, package_name, expected, overlong):
    root = STAGING_DIR / package_name.removesuffix(".7z")
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise RuntimeError(f"Refusing symlinked staging root: {root}")
    intended = {name: size for name, (size, _) in expected.items() if name not in overlong}
    actual = stage_listing(root)
    if actual != intended:
        notice(f"Extracting {package_name} ({len(intended):,} regular JARs)...")
        args = ["7z", "x", "-y", "-bb0", "-spd"]
        args.extend("-x!" + name for name in overlong)
        args.extend([f"-o{root}", str(package_path)])
        result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                text=True, errors="replace")
        if result.returncode:
            raise RuntimeError(f"Extraction failed for {package_name}: {result.stderr[-1500:]}")
        actual = stage_listing(root)
        if actual != intended:
            missing = set(intended) - set(actual)
            extra = set(actual) - set(intended)
            wrong = [p for p in set(actual) & set(intended) if actual[p] != intended[p]]
            raise RuntimeError(
                f"Extracted {package_name} mismatch: missing={len(missing)} "
                f"extra={len(extra)} incorrect_sizes={len(wrong)}; staging retained"
            )
    else:
        notice(f"Verified existing staging for {package_name}")
    return root


def hash_package(conn, package_path, name, root, expected, overlong):
    rows = conn.execute(
        """SELECT id, member_path, declared_size, declared_crc32
        FROM mini_members WHERE package_name=? AND sha256 IS NULL ORDER BY id""",
        (name,),
    ).fetchall()
    notice(f"Hashing {len(rows):,} remaining members in {name}...")
    staged_paths = staged_file_paths(root)
    # Preserve byte-exact paths for filenames containing undecodable bytes.
    conn.execute("""CREATE TABLE IF NOT EXISTS mini_raw_paths (
        member_id INTEGER PRIMARY KEY,
        raw_member_path BLOB NOT NULL
    )""")
    conn.commit()
    updated, issues, raw_paths = [], [], []
    good = 0
    failures = 0

    def commit():
        with conn:
            if updated:
                conn.executemany(
                    """UPDATE mini_members SET actual_size=?, actual_crc32=?,
                    sha1=?, sha256=?, manifest_json=? WHERE id=?""", updated
                )
                conn.executemany(
                    "DELETE FROM mini_issues WHERE member_id=?",
                    ((row[-1],) for row in updated),
                )
            if issues:
                conn.executemany(
                    """INSERT OR REPLACE INTO mini_issues (member_id, issue)
                    VALUES (?, ?)""", issues
                )
            if raw_paths:
                conn.executemany(
                    """INSERT OR REPLACE INTO mini_raw_paths
                    (member_id, raw_member_path) VALUES (?, ?)""", raw_paths
                )
        updated.clear()
        issues.clear()
        raw_paths.clear()

    try:
        for number, (member_id, member, expected_size, expected_crc) in enumerate(rows, 1):
            tmp = None
            try:
                if member in overlong:
                    fd, temp_filename = tempfile.mkstemp(
                        suffix=".jar", prefix="mini-overlong-", dir=BASE / "working"
                    )
                    tmp = Path(temp_filename)
                    with os.fdopen(fd, "wb") as stream:
                        proc = subprocess.run(
                            ["7z", "x", "-so", "-spd", str(package_path), member],
                            stdout=stream, stderr=subprocess.PIPE
                        )
                    if proc.returncode:
                        raise RuntimeError(
                            "Could not stream exact overlong member: "
                            + proc.stderr.decode("utf-8", errors="replace")[-400:]
                        )
                    path = tmp
                else:
                    raw_path = staged_paths[member]
                    path = raw_path.resolve(strict=True)
                    if not path.is_relative_to(root.resolve()) or not path.is_file():
                        raise RuntimeError("Member path escaped staging or is not a file")
                    raw_relative = os.fsencode(raw_path.relative_to(root).as_posix())
                    if raw_relative.decode("utf-8", errors="replace") != member:
                        raise RuntimeError("Filename normalization mismatch")
                    if raw_relative.decode("utf-8", errors="surrogateescape") != member:
                        raw_paths.append((member_id, raw_relative))
                size, crc, sha1, sha256 = hashes(path)
                if (size, crc) != (expected_size, expected_crc):
                    raise RuntimeError(
                        f"Original archive header mismatch: actual=({size}, {crc}) "
                        f"declared=({expected_size}, {expected_crc})"
                    )
                manifest, manifest_issue = manifest_from_jar(path)
                updated.append((size, crc, sha1, sha256, manifest, member_id))
                if manifest_issue:
                    issues.append((member_id, manifest_issue))
                good += 1
            except Exception as exc:
                failures += 1
                issues.append((member_id, f"hash_error: {type(exc).__name__}: {str(exc)[:300]}"))
            finally:
                if tmp is not None:
                    tmp.unlink(missing_ok=True)
            if number % BATCH == 0:
                commit()
            if number % 5000 == 0:
                notice(f"  {name}: {number:,}/{len(rows):,} attempted; "
                       f"newly hashed={good:,}, failures={failures:,}")
        commit()
    except BaseException:
        commit()
        raise


def package_audit(conn, name, expected_count):
    count, hashed, manifests, bad_headers = conn.execute(
        """SELECT COUNT(*), COUNT(sha256), COUNT(manifest_json),
        SUM(CASE WHEN actual_size IS NOT NULL AND
          (actual_size != declared_size OR UPPER(actual_crc32) != UPPER(declared_crc32))
          THEN 1 ELSE 0 END)
        FROM mini_members WHERE package_name=?""", (name,)
    ).fetchone()
    bad = conn.execute(
        """SELECT COUNT(*) FROM mini_issues i JOIN mini_members m ON m.id=i.member_id
        WHERE m.package_name=?""", (name,)
    ).fetchone()[0]
    notice(f"{name}: records={count:,}, hashed={hashed:,}, manifests={manifests:,}, "
           f"header mismatches={bad_headers:,}, issues={bad:,}")
    if (count, hashed, manifests, bad_headers, bad) != (
        expected_count, expected_count, expected_count, 0, 0
    ):
        raise RuntimeError(f"Incomplete {name}; staging retained for investigation")


def main():
    if not SOURCE_ZIP.is_file():
        raise SystemExit(f"Original Mini ZIP missing: {SOURCE_ZIP}")
    if not DB_FILE.is_file():
        raise SystemExit(f"Existing Mini inventory missing: {DB_FILE}")
    (BASE / "working").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    try:
        ensure_schema(conn)
        with zipfile.ZipFile(SOURCE_ZIP) as source:
            infos = {info.filename: info for info in source.infolist()}
            missing = set(PACKAGE_NAMES) - set(infos)
            if missing:
                raise RuntimeError(f"Missing Mini packages: {sorted(missing)}")

            for name in PACKAGE_NAMES:
                notice("\n=== " + name + " ===")
                package = get_package(source, infos[name], name)
                expected, overlong = inspect_7z(package)
                notice(f"Archive headers: {len(expected):,} JARs, "
                       f"overlong paths: {len(overlong):,}")
                record_headers(conn, name, expected)

                pending = conn.execute(
                    """SELECT COUNT(*) FROM mini_members
                    WHERE package_name=? AND sha256 IS NULL""", (name,)
                ).fetchone()[0]
                if pending:
                    root = extract_and_verify(package, name, expected, overlong)
                    hash_package(conn, package, name, root, expected, overlong)
                    package_audit(conn, name, len(expected))
                    # Deletion is limited to this one verified temporary staging tree.
                    shutil.rmtree(root)
                    notice(f"Removed verified temporary staging: {root}")
                else:
                    package_audit(conn, name, len(expected))
                    notice("Already fully processed; no re-extraction necessary")

        total, hashed, manifests, unique = conn.execute(
            """SELECT COUNT(*), COUNT(sha256), COUNT(manifest_json),
            COUNT(DISTINCT sha256) FROM mini_members"""
        ).fetchone()
        issues = conn.execute("SELECT COUNT(*) FROM mini_issues").fetchone()[0]
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        notice("\n=== COMPLETE MINI AUDIT ===")
        notice(f"Total Mini JAR entries: {total:,}")
        notice(f"Independently hashed:  {hashed:,}")
        notice(f"Manifests extracted:   {manifests:,}")
        notice(f"Unique Mini SHA-256:   {unique:,}")
        notice(f"Recorded issues:       {issues:,}")
        notice(f"SQLite integrity:      {integrity}")
        if (total, hashed, manifests, issues, integrity) != (
            EXPECTED_TOTAL, EXPECTED_TOTAL, EXPECTED_TOTAL, 0, "ok"
        ):
            raise RuntimeError("Mini audit did not meet all targets")
        notice("PASS: All nine original Mini packages independently indexed!")
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, sqlite3.Error, zipfile.BadZipFile) as exc:
        print(f"\nSTOPPED: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
