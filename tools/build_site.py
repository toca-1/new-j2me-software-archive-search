#!/usr/bin/env python3
"""Build the *current* J2ME search index from enriched CSV + JSONL metadata.

This is a modernized, independently tested successor to the historical v4
``build_site.py`` (last committed before 97a3b2f). It produces the current
schema-4 records/checksums and **names-v2** search layout. It does not read 7z
archives, extract JARs, hash their contents, or create enrichment inputs.

SAFETY: --out must name a NEW directory. This command does not replace or
modify the repository's existing data/ and never removes an existing output.
It builds in a sibling staging directory, runs the exhaustive index checker,
and publishes only after verification. Supplemental folder, upstream, and
search-summary indexes have separate builders.

Example (do NOT point --out at your live data directory):
    python3 tools/build_site.py --input /path/jarchive-enriched.csv \\
      --details /path/jarchive-enriched-details.jsonl.gz \\
      --out /path/to/separate/j2me-data-candidate
    python3 tools/check_full_index.py --data /path/to/separate/j2me-data-candidate

Python 3.9+; standard library only. For the first full build, ensure plenty of
free space for temporary SQLite databases and the resulting data directory.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import gzip
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile

if __package__:
    from .check_full_index import check_full_index
else:
    from check_full_index import check_full_index

COLLECTIONS = {'JARchiveLite v11': 0, 'JARchive v11': 1}
ARCHIVES = {0: 'JARchiveLite_v11.7z', 1: 'JARchive_v11.7z'}
REQUIRED = {
    'collection', 'filename', 'archive_path', 'size_bytes', 'crc32', 'sha1',
    'sha256', 'archive_file', 'metadata_status', 'midlet_name', 'midlet_vendor',
    'midlet_version', 'cldc', 'midp',
}
RE_SHA1 = re.compile(r'[0-9a-f]{40}\Z')
RE_SHA256 = re.compile(r'[0-9a-f]{64}\Z')
RE_CRC = re.compile(r'[0-9A-F]{8}\Z')
HEX = '0123456789abcdef'


def name_shard_sizes(name_count: int, requested: int, layout: str = 'published'):
    """Yield non-empty shard sizes without materializing the name entries.

    The published 1,024-shard size pattern is exactly reproduced by dividing
    the name stream into 64 ~equal-sized consecutive groups of 16 pieces.
    The split points within
    each group are floor(i * group_size / 16), distributing the extra rows
    throughout the group rather than at its beginning. A single flat split
    was used by the first modernized builder, which produced a different but
    valid index with the same searchable rows.

    For custom shard counts, preserve that builder's flat behavior.
    """
    if name_count < 0 or requested < 1 or layout not in ('published', 'flat'):
        raise ValueError('Invalid name-shard partition request')
    if not name_count:
        return
    if layout == 'published' and requested == 1024:
        # A direct 1,024-way split produces ~2,009-row shards, including a
        # short final shard. Published data instead used 64 x 16 partitioning.
        group_size = math.ceil(name_count / 64)
        for start in range(0, name_count, group_size):
            count = min(group_size, name_count - start)
            for piece in range(16):
                size = (piece + 1) * count // 16 - piece * count // 16
                if size:
                    yield size
    else:
        per_shard = math.ceil(name_count / requested)
        for start in range(0, name_count, per_shard):
            yield min(per_shard, name_count - start)


def as_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(as_bytes(value))


def write_gzip(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output,
                           compresslevel=6, mtime=0) as stream:
            stream.write(as_bytes(value))


def label_text(value):
    # Agrees with the browser search and tools/check_full_index.py.
    return value.strip().lower()


def clean_manifest(manifest):
    if not isinstance(manifest, dict):
        return {}
    result = {}
    for key, value in manifest.items():
        if isinstance(value, (str, int, float, bool)) and value is not None:
            result[str(key)[:120]] = str(value)[:4000]
    return result


def load_details(db, file, max_paths):
    db.execute('''CREATE TABLE details (
        sha256 TEXT NOT NULL, coll INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (sha256,coll)) WITHOUT ROWID''')
    count = 0
    batch = []
    with gzip.open(file, 'rt', encoding='utf-8') as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            info = json.loads(line)
            if not isinstance(info, dict):
                raise ValueError(f'Details line {line_no}: expected JSON object')
            coll = COLLECTIONS.get(info.get('collection'))
            sha = str(info.get('sha256', '')).lower()
            if coll is None or not RE_SHA256.fullmatch(sha):
                raise ValueError(f'Details line {line_no}: invalid collection or SHA-256')
            paths = info.get('paths', [])
            if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
                raise ValueError(f'Details line {line_no}: paths must be strings')
            shown = paths if max_paths < 0 else paths[:max_paths]
            payload = [clean_manifest(info.get('manifest')), shown, len(paths)]
            batch.append((sha, coll, as_bytes(payload).decode('utf-8')))
            count += 1
            if len(batch) == 10000:
                db.executemany('INSERT INTO details VALUES (?,?,?)', batch)
                batch.clear()
        if batch:
            db.executemany('INSERT INTO details VALUES (?,?,?)', batch)
    return count


def load_csv(db, file, expected_count):
    db.executescript('''CREATE TABLE entries (
        sha256 TEXT NOT NULL, sha1 TEXT NOT NULL, size INTEGER NOT NULL,
        coll INTEGER NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL,
        crc TEXT NOT NULL, title TEXT NOT NULL, vendor TEXT NOT NULL,
        version TEXT NOT NULL, cldc TEXT NOT NULL, midp TEXT NOT NULL);
        CREATE TABLE lookup (
            sha256 TEXT PRIMARY KEY, sha1 TEXT NOT NULL, id INTEGER NOT NULL)
            WITHOUT ROWID;
        CREATE TABLE names (
            label TEXT NOT NULL, id INTEGER NOT NULL, kind INTEGER NOT NULL,
            PRIMARY KEY(label,id,kind)) WITHOUT ROWID;
    ''')
    counts = [0, 0]
    batch = []
    with file.open('r', encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        missing = REQUIRED - set(reader.fieldnames or [])
        if missing:
            raise ValueError('Missing enriched CSV columns: ' + ', '.join(sorted(missing)))
        for line_no, row in enumerate(reader, 2):
            coll = COLLECTIONS.get(row.get('collection'))
            if coll is None or row.get('archive_file') != ARCHIVES[coll]:
                raise ValueError(f'CSV row {line_no}: collection/archive mismatch')
            sha1 = row['sha1'].lower()
            sha256 = row['sha256'].lower()
            crc = row['crc32'].upper()
            if not RE_SHA1.fullmatch(sha1) or not RE_SHA256.fullmatch(sha256) or not RE_CRC.fullmatch(crc):
                raise ValueError(f'CSV row {line_no}: invalid checksum')
            path = row['archive_path']
            if (not path or path.startswith('/') or '\\' in path or
                    '..' in path.split('/')):
                raise ValueError(f'CSV row {line_no}: unsafe archive path')
            try:
                size = int(row['size_bytes'])
            except (ValueError, TypeError) as error:
                raise ValueError(f'CSV row {line_no}: invalid size') from error
            if size < 0 or not row['filename']:
                raise ValueError(f'CSV row {line_no}: invalid size or filename')
            if row['metadata_status'] != 'matched':
                raise ValueError(f'CSV row {line_no}: metadata not matched')
            batch.append((sha256, sha1, size, coll, row['filename'], path, crc,
                          row['midlet_name'] or '', row['midlet_vendor'] or '',
                          row['midlet_version'] or '', row['cldc'] or '', row['midp'] or ''))
            counts[coll] += 1
            if len(batch) == 10000:
                db.executemany('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', batch)
                batch.clear()
        if batch:
            db.executemany('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', batch)
    total = sum(counts)
    if not total:
        raise ValueError('Enriched CSV has no records')
    if expected_count and total != expected_count:
        raise ValueError(f'Expected {expected_count:,} rows, found {total:,}')
    db.execute('CREATE INDEX entries_hash ON entries(sha256,coll,path)')
    return counts


def populate_index(db, stage, *, record_chunk, name_shards, max_paths, counts, detail_count,
                   warn_mib, name_layout):
    record_batch, detail_batch, name_buffer = [], [], []
    group = detail_rows = last_hash = None
    unique = 0
    source_masks = Counter()

    def flush_records():
        nonlocal record_batch, detail_batch
        if not record_batch:
            return
        number = (unique - 1) // record_chunk
        write_gzip(stage / 'records' / f'{number:04d}.json.gz', record_batch)
        write_gzip(stage / 'details' / f'{number:04d}.json.gz', detail_batch)
        record_batch, detail_batch = [], []

    def flush_names():
        nonlocal name_buffer
        if name_buffer:
            db.executemany('INSERT OR IGNORE INTO names VALUES (?,?,?)', name_buffer)
            name_buffer = []

    def finish_group():
        nonlocal unique, group, detail_rows
        if group is None:
            return
        record_batch.append(group)
        detail_batch.append(detail_rows)
        db.execute('INSERT INTO lookup VALUES (?,?,?)', (group[0], group[1], unique))
        mask = 0
        labels = set()
        # Index only the *published* primary MIDlet fields. Historical code
        # indexed each CSV row's title/vendor, including non-primary variants;
        # that created labels incompatible with the modern full validator.
        for source in group[3]:
            mask |= 1 << source[0]
            name = label_text(source[1])
            if name:
                labels.add((name, 0))
        for kind, text in ((1, group[4][0]), (2, group[4][1])):
            label = label_text(text)
            if label:
                labels.add((label, kind))
        source_masks[mask] += 1
        name_buffer.extend((label, unique, kind) for label, kind in sorted(labels))
        unique += 1
        if unique % record_chunk == 0:
            flush_records()
            if unique % (record_chunk * 20) == 0:
                print(f'  Grouped {unique:,} distinct contents...', flush=True)
        if len(name_buffer) >= 10000:
            flush_names()
        group = detail_rows = None

    for sha256, sha1, size, coll, filename, path, crc, title, vendor, version, cldc, midp in db.execute(
            'SELECT * FROM entries ORDER BY sha256,coll,path'):
        if sha256 != last_hash:
            finish_group()
            last_hash = sha256
            group = [sha256, sha1, size, [], [title, vendor, version, cldc, midp]]
            detail_rows = []
        elif group[1] != sha1 or group[2] != size:
            raise ValueError(f'Inconsistent SHA-1 or size for SHA-256 {sha256}')
        elif coll == 1 or not group[4][0]:
            # The historical preference is Full metadata, otherwise Lite.
            group[4] = [title, vendor, version, cldc, midp]
        group[3].append([coll, filename, path, crc])
        if not any(d[0] == coll for d in detail_rows):
            item = db.execute('SELECT payload FROM details WHERE sha256=? AND coll=?',
                              (sha256, coll)).fetchone()
            if item is None:
                raise ValueError(f'Missing details for SHA-256 {sha256}, collection {coll}')
            manifest, paths, path_count = json.loads(item[0])
            detail_rows.append([coll, manifest, paths, path_count])
    finish_group()
    flush_names()
    flush_records()
    db.commit()

    # All 16 buckets exist even for prefixes with no entries.
    for field in ('sha1', 'sha256'):
        cursor = db.execute(f'SELECT {field},id FROM lookup ORDER BY {field}')
        row = next(cursor, None)
        for prefix in HEX:
            values = {}
            while row is not None and row[0][0] == prefix:
                values[row[0]] = row[1]
                row = next(cursor, None)
            write_gzip(stage / field / f'{prefix}.json.gz', values)

    cursor = db.execute('SELECT DISTINCT lower(e.crc), l.id FROM entries e '
                        'JOIN lookup l ON e.sha256=l.sha256 ORDER BY lower(e.crc), l.id')
    row = next(cursor, None)
    for prefix in HEX:
        values = {}
        while row is not None and row[0][0] == prefix:
            values.setdefault(row[0], []).append(row[1])
            row = next(cursor, None)
        write_gzip(stage / 'crc32' / f'{prefix}.json.gz', values)

    name_count = db.execute('SELECT count(*) FROM names').fetchone()[0]
    sizes = iter(name_shard_sizes(name_count, name_shards, name_layout))
    target = next(sizes, 0)
    masks = {2: {}, 3: {}}
    number, batch = 0, []

    def flush_name_shard():
        nonlocal number, batch
        if not batch:
            return
        write_gzip(stage / 'names-v2' / f'{number:03d}.json.gz', batch)
        bit = 1 << number
        seen = {2: set(), 3: set()}
        for label, _, _ in batch:
            # Python characters are Unicode code points, as in JS Array.from.
            chars = list(label)
            for n in (2, 3):
                seen[n].update(''.join(chars[i:i + n])
                               for i in range(len(chars) - n + 1))
        for n in (2, 3):
            for gram in seen[n]:
                masks[n][gram] = masks[n].get(gram, 0) | bit
        number += 1
        batch = []
        if number % 64 == 0:
            print(f'  Wrote {number:,} search shards...', flush=True)

    for row in db.execute('SELECT label,id,kind FROM names ORDER BY label,id,kind'):
        batch.append(list(row))
        if len(batch) == target:
            flush_name_shard()
            target = next(sizes, 0)
    if batch or target:
        raise ValueError('Unexpected name shard sizes: did not consume full partition')
    write_gzip(stage / 'names-v2' / 'grams.json.gz', {
        str(n): {gram: format(mask, 'x') for gram, mask in masks[n].items()}
        for n in (2, 3)
    })

    manifest = {
        'schema_version': 4, 'archive': '96x65pixels_j2me',
        'total_rows': sum(counts), 'unique_files': unique,
        'lite_rows': counts[0], 'full_rows': counts[1],
        'shared_files': source_masks[3], 'lite_only': source_masks[1],
        'full_only': source_masks[2],
        'record_chunk': record_chunk, 'names_chunks': number,
        'names_grams': 'names-v2/grams.json.gz',
        'search_terms': name_count, 'name_index_version': 4,
        'max_original_paths': max_paths, 'detail_records_input': detail_count,
        'schema': ['sha256', 'sha1', 'size', 'sources', 'primary_midlet_metadata'],
        'source_schema': ['collection_code', 'filename', 'archive_path', 'crc32'],
        'collections': ['JARchiveLite v11', 'JARchive v11'],
    }
    write_json(stage / 'manifest.json', manifest)

    stats = Counter()
    for file in stage.rglob('*'):
        if file.is_file():
            stats['files'] += 1
            stats['bytes'] += file.stat().st_size
    report = {
        'rows': sum(counts), 'unique_content': unique,
        'search_terms': name_count, 'files': stats['files'] + 1,
        'data_bytes': stats['bytes'],
        'data_mib': round(stats['bytes'] / 2**20, 2),
        'shared': source_masks[3], 'lite_only': source_masks[1],
        'full_only': source_masks[2], 'details_imported': detail_count,
        'max_original_paths': max_paths,
    }
    summary = stage / 'build-summary.json'
    for _ in range(20):
        write_json(summary, report)
        total_bytes = stats['bytes'] + summary.stat().st_size
        if total_bytes == report['data_bytes']:
            break
        report['data_bytes'] = total_bytes
        report['data_mib'] = round(total_bytes / 2**20, 2)
    write_json(summary, report)
    if report['data_mib'] > warn_mib:
        print(f'WARNING: generated data is {report["data_mib"]:.1f} MiB '
              f'(above {warn_mib} MiB)', flush=True)
    print(f'Staged: {unique:,} unique files; {name_count:,} name entries; '
          f'{number:,} name shards', flush=True)
    return manifest


def build(*, source: Path, details: Path, out: Path, expected_count=816215,
          expected_unique=620287, record_chunk=4096, name_shards=1024, max_original_paths=2,
          warn_mib=250, temp_dir: Path | None = None,
          name_layout='published') -> str:
    """Build and validate an entirely new index without touching live data."""
    if record_chunk < 1 or not 1 <= name_shards <= 9999 or max_original_paths < -1:
        raise ValueError('Invalid chunk, shard count, or original-paths limit')
    if name_layout not in ('published', 'flat'):
        raise ValueError('Invalid name shard layout')
    source = Path(source).expanduser().resolve(strict=True)
    details = Path(details).expanduser().resolve(strict=True)
    out = Path(out).expanduser().absolute()
    if out.exists() or out.is_symlink():
        raise ValueError(f'Refusing to overwrite existing directory: {out}')
    if not out.parent.is_dir():
        raise ValueError(f'Output parent directory does not exist: {out.parent}')
    if temp_dir is not None:
        temp_dir = Path(temp_dir).expanduser().resolve(strict=True)
        if not temp_dir.is_dir():
            raise ValueError(f'Not a directory: {temp_dir}')

    # Stage on the output filesystem so the final rename is atomic. No live
    # archive directory, existing index, or source file is ever altered.
    with tempfile.TemporaryDirectory(prefix='.j2me-build-data-', dir=out.parent) as staged:
        stage = Path(staged)
        with tempfile.TemporaryDirectory(prefix='j2me-build-db-', dir=temp_dir) as dbdir:
            db = sqlite3.connect(str(Path(dbdir) / 'build.sqlite'))
            try:
                db.execute('PRAGMA temp_store=FILE')
                db.execute('PRAGMA journal_mode=OFF')
                db.execute('PRAGMA synchronous=OFF')
                counts = load_csv(db, source, expected_count)
                detail_count = load_details(db, details, max_original_paths)
                db.commit()
                print(f'Loaded {sum(counts):,} enriched rows and '
                      f'{detail_count:,} detail entries', flush=True)
                manifest = populate_index(db, stage, record_chunk=record_chunk,
                                          name_shards=name_shards, max_paths=max_original_paths,
                                          counts=counts, detail_count=detail_count, warn_mib=warn_mib,
                                          name_layout=name_layout)
                if expected_unique and manifest['unique_files'] != expected_unique:
                    raise ValueError(f'Expected {expected_unique:,} unique files, '
                                     f'found {manifest["unique_files"]:,}')
            finally:
                db.close()
        # Validator uses a separate temporary SQLite DB; run before publish.
        report = check_full_index(stage, progress=True, temp_dir=temp_dir)
        print(report, flush=True)
        if out.exists() or out.is_symlink():
            raise ValueError(f'Output appeared during build; refusing to overwrite: {out}')
        os.rename(stage, out)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', type=Path, required=True,
                        help='Path to independently verified jarchive-enriched.csv')
    parser.add_argument('--details', type=Path, required=True,
                        help='Path to jarchive-enriched-details.jsonl.gz')
    parser.add_argument('--out', type=Path, required=True,
                        help='NEW separate output directory (must not exist)')
    parser.add_argument('--expected-count', type=int, default=816215,
                        help='Expected source rows; 0 disables the check (default 816215)')
    parser.add_argument('--expected-unique', type=int, default=620287,
                        help='Expected distinct SHA-256 values; 0 disables this check')
    parser.add_argument('--record-chunk', type=int, default=4096)
    parser.add_argument('--name-shards', type=int, default=1024)
    parser.add_argument('--name-layout', choices=('published', 'flat'), default='published',
                        help='Published 64x16 shard boundaries for 1,024 shards (default); '
                             'flat for the previous modernized-builder layout')
    parser.add_argument('--max-original-paths', type=int, default=2)
    parser.add_argument('--warn-mib', type=int, default=250)
    parser.add_argument('--temp-dir', type=Path,
                        help='Existing directory for temporary SQLite files')
    args = parser.parse_args(argv)
    try:
        build(source=args.input, details=args.details, out=args.out,
              expected_count=args.expected_count, expected_unique=args.expected_unique,
              record_chunk=args.record_chunk,
              name_shards=args.name_shards, max_original_paths=args.max_original_paths,
              warn_mib=args.warn_mib, temp_dir=args.temp_dir,
              name_layout=args.name_layout)
    except (ValueError, OSError, sqlite3.Error, OverflowError, json.JSONDecodeError) as error:
        print(f'Build FAILED: {error}', file=sys.stderr)
        return 1
    print(f'Candidate index ready: {args.out} (no existing data was changed)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
