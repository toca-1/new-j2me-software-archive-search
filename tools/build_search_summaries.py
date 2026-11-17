#!/usr/bin/env python3
"""Build optional fast refinement/sorting data from an existing website index.

Reads data/records/ and data/names-v2/ without rebuilding or modifying either.
Writes data/search-summaries/NNN.json.gz aligned with the existing name shards,
so a text search can fetch compact metadata for its matching name shards rather
than downloading many scattered full record shards.

Usage: python3 tools/build_search_summaries.py --repo .
Python 3.9+; standard library only. Requires the complete generated data/ tree.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile


def compact_json(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def write_gzip_json(path: Path, obj):
    with path.open('wb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=9) as gz:
            gz.write(compact_json(obj))


def build(repo: Path) -> None:
    data = repo / 'data'
    manifest_path = data / 'manifest.json'
    if not manifest_path.is_file():
        raise ValueError('Missing data/manifest.json: use a checkout with the complete generated index')
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get('schema_version') != 4 or manifest.get('schema') != [
        'sha256', 'sha1', 'size', 'sources', 'primary_midlet_metadata'
    ]:
        raise ValueError('Unrecognized site index schema')
    count = manifest.get('unique_files')
    chunk = manifest.get('record_chunk')
    names_count = manifest.get('names_chunks')
    grams = manifest.get('names_grams')
    suffix = '/grams.json.gz'
    if (not isinstance(count, int) or count < 1 or
        not isinstance(chunk, int) or chunk < 1 or
        not isinstance(names_count, int) or names_count < 1 or
        not isinstance(grams, str) or not grams.endswith(suffix)):
        raise ValueError('Invalid index counts or name-index path')
    name_dir = grams[:-len(suffix)]
    if any(not part or part in ('.', '..') or '\\' in part for part in name_dir.split('/')):
        raise ValueError('Unsafe name-index directory')

    target = data / 'search-summaries'
    staging = Path(tempfile.mkdtemp(prefix='.search-summaries-staging-', dir=data))
    db = None
    try:
        db = sqlite3.connect(staging / 'summaries.sqlite')
        db.execute('PRAGMA journal_mode = DELETE')
        db.execute('PRAGMA synchronous = NORMAL')
        db.execute('CREATE TABLE summary (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')

        total_records = 0
        for n in range((count + chunk - 1) // chunk):
            path = data / 'records' / f'{n:04d}.json.gz'
            with gzip.open(path, 'rt', encoding='utf-8') as stream:
                records = json.load(stream)
            expected = min(chunk, count - total_records)
            if not isinstance(records, list) or len(records) != expected:
                raise ValueError(f'Expected {expected} records in {path}')
            rows = []
            for offset, record in enumerate(records):
                # Only fields currently used by refinement/sorting, no hashes,
                # archive paths, CRCs or full manifest details.
                if not isinstance(record, list) or len(record) != 5:
                    raise ValueError(f'Unexpected record format in {path} at {offset}')
                bytesize, sources, quick = record[2], record[3], record[4]
                if (not isinstance(bytesize, int) or not isinstance(sources, list) or
                    not sources or not isinstance(quick, list)):
                    raise ValueError(f'Invalid record metadata in {path} at {offset}')
                filenames = [source[1] for source in sources]
                value = json.dumps([bytesize, quick, filenames], ensure_ascii=False,
                                   separators=(',', ':'))
                rows.append((total_records + offset, value))
            db.executemany('INSERT INTO summary VALUES (?, ?)', rows)
            db.commit()
            total_records += len(records)
            if (n + 1) % 25 == 0 or total_records == count:
                print(f'Indexed {total_records:,}/{count:,} records', flush=True)

        seen = bytearray(count)
        total_references = 0
        total_bytes = 0
        for shard in range(names_count):
            names_path = data / name_dir / f'{shard:03d}.json.gz'
            with gzip.open(names_path, 'rt', encoding='utf-8') as stream:
                labels = json.load(stream)
            if not isinstance(labels, list):
                raise ValueError(f'Invalid name shard: {names_path}')
            ids = set()
            for row in labels:
                if (not isinstance(row, list) or len(row) < 3 or
                    not isinstance(row[1], int) or not 0 <= row[1] < count):
                    raise ValueError(f'Invalid name-index row in {names_path}: {row!r}')
                ids.add(row[1])
            entries = []
            ordered_ids = sorted(ids)
            # Under SQLite's portable parameter limit (999).
            for start in range(0, len(ordered_ids), 500):
                batch = ordered_ids[start:start + 500]
                if not batch:
                    continue
                placeholders = ','.join('?' for _ in batch)
                fetched = dict(db.execute(
                    f'SELECT id,value FROM summary WHERE id IN ({placeholders})', batch))
                if len(fetched) != len(batch):
                    raise ValueError(f'Name shard {shard} has IDs missing from record index')
                for id_ in batch:
                    bytesize, quick, filenames = json.loads(fetched[id_])
                    entries.append([id_, bytesize, quick, filenames])
                    seen[id_] = 1
            out = staging / f'{shard:03d}.json.gz'
            write_gzip_json(out, entries)
            total_bytes += out.stat().st_size
            total_references += len(entries)
            if (shard + 1) % 16 == 0 or shard + 1 == names_count:
                print(f'Built {shard + 1}/{names_count} summary shards', flush=True)

        if not all(seen):
            missing = count - seen.count(1)
            # Some records may not have any indexed name (possible with damaged
            # metadata). Hash searches use the original records anyway; do not
            # silently claim every ID was covered.
            print(f'Note: {missing:,} records have no searchable name-index label', flush=True)

        index_info = {
            'schema_version': 1,
            'index_manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
            'unique_files': count,
            'record_chunk': chunk,
            'names_chunks': names_count,
            'names_grams': grams,
            'summary_entries': total_references,
            'indexed_unique_files': seen.count(1),
        }
        (staging / 'manifest.json').write_bytes(compact_json(index_info) + b'\n')
        db.close()
        db = None
        (staging / 'summaries.sqlite').unlink()
        previous = None
        try:
            if target.exists():
                previous = data / (staging.name + '-previous')
                os.replace(target, previous)
            os.replace(staging, target)
        except Exception:
            if previous and previous.exists() and not target.exists():
                os.replace(previous, target)
            raise
        if previous and previous.exists():
            shutil.rmtree(previous)
        print(f'\nBuilt data/search-summaries/ successfully')
        print(f'  Unique IDs covered: {seen.count(1):,}/{count:,}')
        print(f'  Shard metadata entries: {total_references:,}')
        print(f'  Compressed summary data: {total_bytes / (1024 ** 2):.2f} MiB')
        print('  Existing records, name index, main manifest, and download links were not modified.')
    finally:
        if db is not None:
            db.close()
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd(), help='Website repo (default: current directory)')
    args = parser.parse_args()
    try:
        build(args.repo.expanduser().resolve())
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
