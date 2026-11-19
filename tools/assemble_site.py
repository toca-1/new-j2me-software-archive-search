#!/usr/bin/env python3
"""Build a standalone website preview using newly generated index data only.

The builders are from this checkout; existing data/ and historical releases
are not used. See docs/REBUILD.md.
"""
from __future__ import annotations

import csv
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HOME = Path.home()
BASE = HOME / 'j2me-independent-rebuild'
OUTPUT = BASE / 'independent-output'
SOURCE_DATA = OUTPUT / 'site-data-v2'
MINI_DB = BASE / 'working' / 'mini-inventory.sqlite'
COMBINED_GZIP = OUTPUT / 'jarchive-combined-verified-v2.csv.gz'
REPO = Path(__file__).resolve().parents[1]
DEST = OUTPUT / 'website-preview'
EXPECTED_MINI = 225867
EXPECTED_UNIQUE = 621715
EXPECTED_ROWS = 817643
EXPECTED_MINI_ONLY = 1428
PACKAGES = {'#.7z','A-B.7z','C-D.7z','E-G.7z','H-L.7z','M-O.7z','P-R.7z','S.7z','T-Z.7z'}
HEX40 = re.compile(r'[0-9a-f]{40}\Z')
HEX64 = re.compile(r'[0-9a-f]{64}\Z')


def die(message):
    raise RuntimeError(message)


def announce(message):
    print(message, flush=True)


def run(*args):
    announce('\n>>> ' + ' '.join(str(x) for x in args))
    subprocess.run([str(x) for x in args], check=True)


def preflight():
    if DEST.exists() or DEST.is_symlink():
        die(f'Refusing to overwrite existing preview: {DEST}')
    for file in (SOURCE_DATA / 'manifest.json', MINI_DB, COMBINED_GZIP,
                 REPO / 'index.html', REPO / 'jarchive_download.py',
                 REPO / 'tools/build_folder_groups.py',
                 REPO / 'tools/build_search_summaries.py',
                 REPO / 'tools/build_mini_downloads.py',
                 REPO / 'tools/check_folder_index.py',
                 REPO / 'tools/check_full_index.py'):
        if not file.is_file():
            die(f'Required input not found: {file}')
    for directory in (REPO / 'assets', REPO / 'html', SOURCE_DATA / 'records', SOURCE_DATA / 'names-v2'):
        if not directory.is_dir():
            die(f'Required directory not found: {directory}')
    manifest = json.loads((SOURCE_DATA / 'manifest.json').read_text(encoding='utf-8'))
    expected = (4, EXPECTED_UNIQUE, EXPECTED_ROWS, 1024, EXPECTED_MINI_ONLY)
    actual = tuple(manifest.get(key) for key in
                   ('schema_version', 'unique_files', 'total_rows', 'names_chunks', 'mini_only'))
    if actual != expected:
        die(f'Unexpected independent core manifest {actual!r}; expected {expected!r}')
    announce(f'Preflight passed: {EXPECTED_UNIQUE:,} unique, {EXPECTED_ROWS:,} source rows.')


def generate_mini_manifest(db_path: Path, destination: Path):
    """Generate a Mini download inventory using only independently hashed SQLite rows.

    The original 7z listing replaces invalid UTF-8 bytes. mini_raw_paths stores
    those members' REAL bytes, so write literal \\udcXX escapes for the
    repository's mini URL builder to restore through surrogateescape.
    """
    announce('\nGenerating complete Mini SHA-1 manifest from independent SQLite...')
    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        has_raw = 'mini_raw_paths' in tables
        query = '''SELECT m.package_name, m.member_path, m.declared_size,
                          m.actual_size, m.sha1, m.sha256, r.raw_member_path
                   FROM mini_members m
                   LEFT JOIN mini_raw_paths r ON r.member_id=m.id
                   ORDER BY m.package_name, m.member_path''' if has_raw else '''
                  SELECT package_name, member_path, declared_size, actual_size,
                         sha1, sha256, NULL FROM mini_members
                  ORDER BY package_name, member_path'''
        seen = set()
        count = raw_count = 0
        packages = set()
        with destination.open('w', encoding='utf-8', newline='') as stream:
            writer = csv.DictWriter(stream, fieldnames=(
                'sha1','archive','internal_path','filename','size_bytes'),
                lineterminator='\n')
            writer.writeheader()
            for archive, db_path, declared, actual, sha1, sha256, raw in conn.execute(query):
                count += 1
                if archive not in PACKAGES:
                    die(f'Unexpected Mini package: {archive!r}')
                if not isinstance(db_path, str) or not db_path.endswith('.jar') or '/' not in db_path:
                    die(f'Invalid Mini member path at row {count}: {db_path!r}')
                if actual is None or actual != declared or declared <= 0:
                    die(f'Unhashed or mismatched Mini member at row {count}')
                if not isinstance(sha1,str) or not HEX40.fullmatch(sha1.lower()):
                    die(f'Invalid SHA-1 at row {count}')
                if not isinstance(sha256,str) or not HEX64.fullmatch(sha256.lower()):
                    die(f'Invalid SHA-256 at row {count}')
                if sha1 in seen:
                    die(f'Duplicate Mini SHA-1: {sha1}')
                seen.add(sha1)
                packages.add(archive)
                path = db_path
                if raw is not None:
                    raw_count += 1
                    raw_bytes = bytes(raw)
                    if raw_bytes.decode('utf-8', errors='replace') != db_path:
                        die(f'Raw Mini filename bytes do not match listing at row {count}')
                    # UTF-8 chars stay readable; non-UTF-8 bytes become literal
                    # ASCII \\udcXX escape sequences the site's builder knows.
                    path = os.fsdecode(raw_bytes).encode('utf-8', errors='backslashreplace').decode('utf-8')
                writer.writerow({
                    'sha1':sha1.lower(), 'archive':archive,
                    'internal_path':path,
                    'filename':path.rsplit('/',1)[-1],
                    'size_bytes':declared,
                })
        if count != EXPECTED_MINI or packages != PACKAGES:
            die(f'Mini inventory incomplete: rows={count}, packages={sorted(packages)}')
        announce(f'Mini manifest complete: {count:,} members in {len(packages)} packages; '
                 f'{raw_count} byte-preserved unusual filenames.')
        announce(f'Mini manifest: {destination}')
    finally:
        conn.close()


def expand_own_csv(gz_path: Path, destination: Path):
    announce('\nExpanding independently generated v2 CSV for Mini cross-validation...')
    with gzip.open(gz_path, 'rb') as source, destination.open('wb') as sink:
        shutil.copyfileobj(source, sink, 1024 * 1024)
    announce(f'Expanded CSV size: {destination.stat().st_size / (1024**2):.1f} MiB')


def verify_mini(site: Path):
    directory = site / 'data/mini'
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('rows') != EXPECTED_MINI or set(manifest.get('packages', [])) != PACKAGES:
        die('Generated Mini map manifest has incorrect counts or packages')
    with gzip.open(directory / 'cli.json.gz', 'rt', encoding='utf-8') as stream:
        cli = json.load(stream)
    if len(cli.get('sha256',{})) != EXPECTED_MINI_ONLY:
        die('Mini-only CLI mapping does not contain 1,428 records')
    announce(f'Mini download maps verified: {manifest["rows"]:,} members; '
             f'{len(cli["sha256"]):,} Mini-only CLI routes.')


def main():
    preflight()
    stage = Path(tempfile.mkdtemp(prefix='.website-preview-staging-', dir=OUTPUT))
    announce(f'\nBuilding independent website in staging directory: {stage}')
    try:
        shutil.copytree(SOURCE_DATA, stage / 'data')
        shutil.copytree(REPO / 'assets', stage / 'assets')
        shutil.copytree(REPO / 'html', stage / 'html')
        shutil.copy2(REPO / 'index.html', stage / 'index.html')
        shutil.copy2(REPO / 'jarchive_download.py', stage / 'jarchive_download.py')
        if (REPO / '.nojekyll').is_file():
            shutil.copy2(REPO / '.nojekyll', stage / '.nojekyll')
        # The GitHub repository's data/ is NEVER accessed.
        derived = stage / '.reconstruction-inputs'
        derived.mkdir()
        mini_manifest = derived / 'mini_sha1_manifest_independent.csv'
        combined_csv = derived / 'jarchive-combined-verified-v2.csv'
        generate_mini_manifest(MINI_DB, mini_manifest)
        expand_own_csv(COMBINED_GZIP, combined_csv)

        run(sys.executable, REPO / 'tools/build_folder_groups.py', '--repo', stage)
        run(sys.executable, REPO / 'tools/build_search_summaries.py', '--repo', stage)
        run(sys.executable, REPO / 'tools/build_mini_downloads.py',
            '--manifest', mini_manifest, '--v2-csv', combined_csv,
            '--expected-rows', EXPECTED_MINI, '--out', stage / 'data/mini')
        verify_mini(stage)
        run(sys.executable, REPO / 'tools/check_folder_index.py',
            '--repo', stage, '--require-folders')
        run(sys.executable, REPO / 'tools/check_full_index.py',
            '--data', stage / 'data')
        # The combined CSV is already preserved separately as .csv.gz.
        shutil.rmtree(derived)  # Inputs for builders are not website assets.
        announce('\nAll independent supplemental builders and validators passed.')
        if DEST.exists() or DEST.is_symlink():
            die(f'Preview appeared during build; refusing to overwrite: {DEST}')
        stage.rename(DEST)
        announce(f'\nPASS: Independent website preview ready at: {DEST}')
        announce('Start local preview with:')
        announce(f'  cd "{DEST}" && python3 -m http.server 8001')
        announce('Open Firefox at http://localhost:8001/')
        announce('Original repository data/ and both SQLite inventories were not modified.')
        announce('Historical upstream/v1 downloader mappings are not regenerated.')
    except BaseException:
        announce(f'\nStopped. Staging retained for inspection: {stage}')
        raise


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, sqlite3.Error, subprocess.CalledProcessError, EOFError) as exc:
        print(f'FAILED: {exc}', file=sys.stderr, flush=True)
        sys.exit(1)
