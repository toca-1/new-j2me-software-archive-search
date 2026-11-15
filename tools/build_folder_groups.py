#!/usr/bin/env python3
"""Build a *supplemental*, lazy-loadable archive-folder browser index.

Reads the published site's data/records/*.json.gz (one record per unique SHA-256).
Combines identical folder spelling from Lite and Full, keeping all individual
hashes separate. Never changes the existing main search index or its records.

Run from anywhere:
  python3 tools/build_folder_groups.py --repo .

Python 3.9+, standard library only. Writes data/folders/ after a successful build.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import itertools
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile


def bucket_for(folder: str) -> str:
    """UTF-8 FNV-1a 32-bit, upper byte; equivalent to the browser implementation."""
    h = 2166136261
    for byte in folder.encode('utf-8'):
        h = ((h ^ byte) * 16777619) & 0xffffffff
    return f'{h >> 24:02x}'


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def write_gzip_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    # gzip -n equivalent: no timestamp, no filename; deterministic compressed asset.
    with path.open('wb') as file:
        with gzip.GzipFile(filename='', mode='wb', fileobj=file, mtime=0, compresslevel=9) as gz:
            gz.write(compact_json(obj))


def build(repo: Path) -> None:
    data = repo / 'data'
    source_manifest_path = data / 'manifest.json'
    if not source_manifest_path.is_file() or not (data / 'records').is_dir():
        raise ValueError(f'{data} must have manifest.json and records/ before building groups')
    manifest_bytes = source_manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get('schema_version') != 4:
        raise ValueError('Expected v4 web index; refusing unknown schema')
    if manifest.get('schema') != ['sha256','sha1','size','sources','primary_midlet_metadata']:
        raise ValueError('Unexpected records schema')
    if manifest.get('source_schema') != ['collection_code','filename','archive_path','crc32']:
        raise ValueError('Unexpected source schema')
    chunk = manifest.get('record_chunk')
    count = manifest.get('unique_files')
    if not isinstance(chunk, int) or chunk < 1 or not isinstance(count, int) or count < 1:
        raise ValueError('Invalid index manifest counts')
    chunks = (count + chunk - 1) // chunk
    target = data / 'folders'
    staging = Path(tempfile.mkdtemp(prefix='.folders-staging-', dir=data))
    connection = None
    try:
        connection = sqlite3.connect(str(staging / 'membership.sqlite'))
        connection.execute('PRAGMA journal_mode = DELETE')
        connection.execute('PRAGMA synchronous = NORMAL')
        connection.execute('''CREATE TABLE member (
            bucket TEXT NOT NULL, folder TEXT NOT NULL, id INTEGER NOT NULL,
            sha TEXT NOT NULL, title TEXT NOT NULL, vendor TEXT NOT NULL,
            version TEXT NOT NULL, bytes INTEGER NOT NULL,
            PRIMARY KEY(bucket,folder,id)
        ) WITHOUT ROWID''')
        total_sources = 0
        record_count = 0
        for n in range(chunks):
            path = data / 'records' / f'{n:04d}.json.gz'
            if not path.is_file():
                raise FileNotFoundError(f'Missing web index record shard: {path}')
            with gzip.open(path, 'rt', encoding='utf-8') as stream:
                records = json.load(stream)
            if not isinstance(records, list):
                raise ValueError(f'Unexpected record shard format: {path}')
            rows = []
            for offset, record in enumerate(records):
                record_id = n * chunk + offset
                if record_id >= count:
                    raise ValueError('Record shards exceed unique_files')
                sha, _, bytesize, sources, quick = record
                if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
                    raise ValueError(f'Invalid SHA-256 at ID {record_id}')
                if not isinstance(quick, list) or len(quick) < 3:
                    raise ValueError(f'Invalid quick metadata at ID {record_id}')
                title = str(quick[0] or '')
                vendor = str(quick[1] or '')
                version = str(quick[2] or '')
                if not isinstance(bytesize, int):
                    raise ValueError(f'Invalid file size at ID {record_id}')
                for source in sources:
                    if source[0] not in (0,1) or not isinstance(source[2], str):
                        raise ValueError(f'Invalid source at ID {record_id}')
                    folder, slash, _ = source[2].rpartition('/')
                    if not slash:
                        raise ValueError(f'Missing folder at record {record_id}')
                    rows.append((bucket_for(folder), folder, record_id, sha,
                                 title or str(source[1]), vendor, version, bytesize))
                    total_sources += 1
                record_count += 1
            connection.executemany('INSERT OR IGNORE INTO member VALUES (?,?,?,?,?,?,?,?)', rows)
            connection.commit()
            if (n+1) % 20 == 0 or n+1 == chunks:
                print(f'Processed {n+1}/{chunks} record shards', flush=True)
        if record_count != count:
            raise ValueError(f'Expected {count} unique records, found {record_count}')

        counts = []
        candidate_ids = set()
        largest = (0, '')
        bucket_data = {}
        current_bucket = None
        shards_written = 0
        def flush_bucket(name, data):
            nonlocal shards_written
            if data:
                write_gzip_json(staging / 'groups' / f'{name}.json.gz', data)
                shards_written += 1

        cursor = connection.execute('SELECT bucket,folder,id,sha,title,vendor,version,bytes '
                                    'FROM member ORDER BY bucket,folder,id')
        for (_bucket, folder), grouped in itertools.groupby(cursor, key=lambda row: (row[0],row[1])):
            if current_bucket != _bucket:
                if current_bucket is not None:
                    flush_bucket(current_bucket, bucket_data)
                bucket_data = {}
                current_bucket = _bucket
            entries = [[id_,sha,title,vendor,version,bytes_] for _,_,id_,sha,title,vendor,version,bytes_ in grouped]
            if len(entries) < 2:
                continue
            counts.append([folder, len(entries)])
            bucket_data[folder] = entries
            candidate_ids.update(entry[0] for entry in entries)
            if len(entries) > largest[0]:
                largest = (len(entries), folder)
        if current_bucket is not None:
            flush_bucket(current_bucket, bucket_data)
        write_gzip_json(staging / 'counts.json.gz', counts)
        stats = {
            'schema_version': 1,
            'index_manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
            'unique_files': count,
            'record_chunk': chunk,
            'folders_with_multiple_contents': len(counts),
            'unique_contents_in_multiple_content_folder': len(candidate_ids),
            'group_shards': shards_written,
            'largest_folder': [largest[1], largest[0]],
            'source_entries_seen': total_sources,
        }
        (staging / 'manifest.json').write_bytes(compact_json(stats) + b'\n')
        connection.close()
        connection = None
        (staging / 'membership.sqlite').unlink()
        # Replace only supplemental assets, and only when the entire build succeeded.
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
        total_bytes = sum(p.stat().st_size for p in target.rglob('*') if p.is_file())
        print(f'\nBuilt data/folders/ successfully')
        print(f"  Folder groups: {len(counts):,}")
        print(f"  Distinct contents in groups: {len(candidate_ids):,} / {count:,}")
        print(f"  Shards: {shards_written}")
        print(f"  Largest: {largest[1]} ({largest[0]:,})")
        print(f'  Total supplementary compressed assets: {total_bytes / (1024**2):.2f} MiB')
        print('Main search data, existing web files, and original archives were not modified.')
    finally:
        if connection is not None:
            connection.close()
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd(), help='Website repository (default: current directory)')
    args = parser.parse_args()
    try:
        build(args.repo.expanduser().resolve())
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
