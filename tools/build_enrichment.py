#!/usr/bin/env python3
"""Adapt independently hashed J2ME SQLite databases to build_site.py inputs.

Reads ONLY the user's independent v1 and Mini inventories and independently
produced combined-v2 CSV. Does NOT read the project's published data/ tree or
published release CSVs. Writes a fresh output directory; refuses overwrite.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

FIELDS = [
    'collection', 'filename', 'archive_path', 'size_bytes', 'crc32',
    'sha1', 'sha256', 'archive_file', 'metadata_status',
    'midlet_name', 'midlet_vendor', 'midlet_version', 'cldc', 'midp',
]
COLLECTIONS = {
    'JARchiveLite v11': 'lite',
    'JARchive v11': 'full',
}
MINI = '96x65pixels J2ME mini'
ARCHIVES = {
    'lite': 'JARchiveLite_v11.7z',
    'full': 'JARchive_v11.7z',
}
MINI_PACKAGES = {'#.7z', 'A-B.7z', 'C-D.7z', 'E-G.7z',
                 'H-L.7z', 'M-O.7z', 'P-R.7z', 'S.7z', 'T-Z.7z'}


def readonly_db(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise ValueError(f'Missing independent database: {path}')
    # Avoid URI issues with filename characters by using sqlite3's absolute URI.
    con = sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True)
    con.execute('PRAGMA query_only=ON')
    return con


def as_text(value: object) -> str:
    return str(value) if value is not None else ''


def manifest_attrs(raw: str) -> dict[str, str]:
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError('A stored manifest is not a JSON object')
    return {str(key): as_text(value) for key, value in obj.items() if value is not None}


def principal_fields(manifest: dict[str, str]) -> dict[str, str]:
    ci = {key.casefold(): value for key, value in manifest.items()}
    return {
        'midlet_name': ci.get('midlet-name', ''),
        'midlet_vendor': ci.get('midlet-vendor', ''),
        'midlet_version': ci.get('midlet-version', ''),
        'cldc': ci.get('microedition-configuration', ''),
        'midp': ci.get('microedition-profile', ''),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path,
                        default=Path.home() / 'j2me-independent-rebuild')
    parser.add_argument('--expected-rows', type=int, default=817643)
    parser.add_argument('--expected-unique', type=int, default=621715)
    args = parser.parse_args()

    base = args.base.expanduser().resolve(strict=True)
    v1_path = base / 'working/v1-inventory.sqlite'
    mini_path = base / 'working/mini-inventory.sqlite'
    source_csv = base / 'independent-output/jarchive-combined-verified-v2.csv.gz'
    parent = base / 'independent-output'
    target = parent / 'enrichment-v2'
    if not source_csv.is_file():
        raise ValueError(f'Missing independently produced CSV: {source_csv}')
    if target.exists() or target.is_symlink():
        raise ValueError(f'Refusing to overwrite: {target}')
    if not parent.is_dir():
        raise ValueError(f'Output directory is missing: {parent}')

    v1 = readonly_db(v1_path)
    mini = readonly_db(mini_path)
    staging = Path(tempfile.mkdtemp(prefix='.enrichment-stage-', dir=parent))
    counts = {'lite': 0, 'full': 0, 'mini': 0}
    details_seen: set[tuple[str, str]] = set()
    records = 0
    try:
        enriched_path = staging / 'jarchive-enriched.csv'
        details_path = staging / 'jarchive-enriched-details.jsonl.gz'
        with (gzip.open(source_csv, 'rt', encoding='utf-8-sig', newline='') as source,
              enriched_path.open('w', encoding='utf-8', newline='') as enriched,
              gzip.open(details_path, 'wt', encoding='utf-8', newline='\n') as detail_file):
            reader = csv.DictReader(source)
            required = set(FIELDS[:8])
            if not required.issubset(reader.fieldnames or []):
                raise ValueError(f'Combined CSV missing columns: {required - set(reader.fieldnames or [])}')
            writer = csv.DictWriter(enriched, fieldnames=FIELDS, lineterminator='\n')
            writer.writeheader()

            for row in reader:
                collection, package = row['collection'], row['archive_file']
                path = row['archive_path']
                if collection in COLLECTIONS:
                    collection_key = COLLECTIONS[collection]
                    if package != ARCHIVES[collection_key]:
                        raise ValueError(f'Unexpected archive for {collection}: {package}')
                    found = v1.execute('''
                        SELECT actual_size, actual_crc32, sha1, sha256, manifest_json
                        FROM members WHERE collection=? AND member_path=?
                    ''', (collection_key, path)).fetchone()
                elif collection == MINI:
                    collection_key = 'mini'
                    if package not in MINI_PACKAGES:
                        raise ValueError(f'Unexpected Mini package: {package}')
                    found = mini.execute('''
                        SELECT actual_size, actual_crc32, sha1, sha256, manifest_json
                        FROM mini_members WHERE package_name=? AND member_path=?
                    ''', (package, path)).fetchone()
                else:
                    raise ValueError(f'Unknown collection: {collection}')

                if found is None:
                    raise ValueError(f'Independent SQLite record missing: {package} / {path!r}')
                size, crc, sha1, sha256, raw_manifest = found
                if (size != int(row['size_bytes']) or
                        as_text(crc).upper() != row['crc32'].upper() or
                        as_text(sha1).lower() != row['sha1'].lower() or
                        as_text(sha256).lower() != row['sha256'].lower()):
                    raise ValueError(f'Independent database/CSV disagreement for {package} / {path!r}')
                if not raw_manifest:
                    raise ValueError(f'No independently extracted manifest for {package} / {path!r}')
                if row['filename'] != path.rsplit('/', 1)[-1]:
                    raise ValueError(f'CSV filename differs from member path: {path!r}')

                attrs = manifest_attrs(raw_manifest)
                enriched_row = dict(row)
                enriched_row.update(principal_fields(attrs))
                # build_site.py uses 'matched' for original v1 rows, and
                # 'extracted' for Mini JAR manifest-derived metadata.
                enriched_row['metadata_status'] = (
                    'extracted' if collection_key == 'mini' else 'matched'
                )
                writer.writerow({key: enriched_row.get(key, '') for key in FIELDS})
                counts[collection_key] += 1
                records += 1

                detail_key = (collection, row['sha256'].lower())
                if detail_key not in details_seen:
                    details_seen.add(detail_key)
                    # Historical source-path lists cannot be inferred from JAR
                    # bytes; do not invent them. The archive member paths are
                    # preserved separately in the enriched CSV.
                    detail = {
                        'collection': collection,
                        'sha256': row['sha256'].lower(),
                        'manifest': attrs,
                        'paths': [],
                        'path_count': 0,
                    }
                    detail_file.write(json.dumps(detail, ensure_ascii=False, separators=(',', ':')) + '\n')

                if records % 100000 == 0:
                    print(f'  Enriched {records:,} source rows', flush=True)

        print(f'CSV source rows: {records:,}', flush=True)
        print(f'Collections: {counts}', flush=True)
        print(f'Detail entries (unique collection + SHA256): {len(details_seen):,}', flush=True)
        if args.expected_rows and records != args.expected_rows:
            raise ValueError(f'Expected {args.expected_rows:,} rows, got {records:,}')
        unique_sha = {sha for _, sha in details_seen}
        if args.expected_unique and len(unique_sha) != args.expected_unique:
            raise ValueError(f'Expected {args.expected_unique:,} unique contents, got {len(unique_sha):,}')
        if args.expected_rows == 817643 and counts != {'lite': 198184, 'full': 618031, 'mini': 1428}:
            raise ValueError('Unexpected v2 per-collection counts')

        os.rename(staging, target)
        print(f'PASS: Independent enrichment ready at {target}', flush=True)
        print('Input databases and original CSV were not modified.', flush=True)
    except BaseException:
        print('Output not published: staging failed. Existing inputs are untouched.', flush=True)
        raise
    finally:
        v1.close()
        mini.close()
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == '__main__':
    main()
