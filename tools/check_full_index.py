#!/usr/bin/env python3
"""Exhaustively validate the generated v4 search index before major rebuilds.

Checks every record/detail, checksum lookup, name entry and gram bitmap. Unlike
``tests/check_index.py``, this is deliberately expensive and **not** part of
GitHub Pages' routine deployment workflow. Uses temporary disk-backed SQLite
to avoid holding all records in RAM; the generated index is never modified.

    python3 tools/check_full_index.py --repo .
    python3 tools/check_full_index.py --data /path/to/data
    python3 tools/check_full_index.py --repo . --temp-dir /large/temporary/disk

Requires the complete generated data/ directory. Python 3.9+ standard library.
Does not inspect original JAR bytes, external download links, or optional
folder/upstream/compact-summary indexes (those have separate checks/builders).
"""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
import re
import sqlite3
import sys
import tempfile

HEX = '0123456789abcdef'
RE_SHA256 = re.compile(r'[0-9a-f]{64}\Z')
RE_SHA1 = re.compile(r'[0-9a-f]{40}\Z')
RE_CRC32 = re.compile(r'[0-9a-fA-F]{8}\Z')
SCHEMA = ['sha256', 'sha1', 'size', 'sources', 'primary_midlet_metadata']
SOURCE_SCHEMA = ['collection_code', 'filename', 'archive_path', 'crc32']


class FullIndexError(ValueError):
    """Corrupt, incomplete, or internally inconsistent generated search data."""


def require(condition, message):
    if not condition:
        raise FullIndexError(message)


def read_json(path: Path, *, gz: bool = False):
    try:
        if gz:
            with gzip.open(path, 'rt', encoding='utf-8') as stream:
                return json.load(stream)
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, EOFError, UnicodeError, ValueError) as exc:
        raise FullIndexError(f'Cannot read {path}: {exc}') from exc


def valid_id(value, count):
    return type(value) is int and 0 <= value < count


def check_files(directory: Path, expected: set[str], *, label: str):
    try:
        found = {item.name for item in directory.iterdir() if item.name.endswith('.json.gz')}
    except OSError as exc:
        raise FullIndexError(f'Cannot list {directory}: {exc}') from exc
    missing = expected - found
    extra = found - expected
    if missing or extra:
        raise FullIndexError(f'{label} shard set incorrect: '
                             f'{len(missing)} missing {sorted(missing)[:3]}, '
                             f'{len(extra)} unexpected {sorted(extra)[:3]}')


def label_text(value):
    # This mirrors the name index's case-insensitive text labels. Empty labels
    # are not searchable and are deliberately not indexed.
    return value.strip().lower()


def expected_search_labels(sources, quick):
    labels = {(0, label_text(source[1])) for source in sources}
    labels.update((kind, label_text(quick[index])) for kind, index in ((1, 0), (2, 1))
                  if isinstance(quick[index], str))
    return {(kind, label) for kind, label in labels if label}


def validate_record(record, record_id):
    where = f'record ID {record_id}'
    require(isinstance(record, list) and len(record) == 5,
            f'{where}: expected [sha256,sha1,size,sources,quick]')
    sha256, sha1, bytesize, sources, quick = record
    require(isinstance(sha256, str) and RE_SHA256.fullmatch(sha256),
            f'{where}: invalid SHA-256 {sha256!r}')
    require(isinstance(sha1, str) and RE_SHA1.fullmatch(sha1),
            f'{where}: invalid SHA-1 {sha1!r}')
    require(type(bytesize) is int and bytesize >= 0, f'{where}: invalid size {bytesize!r}')
    require(isinstance(sources, list) and bool(sources), f'{where}: missing archive sources')
    require(isinstance(quick, list) and len(quick) == 5 and
            all(item is None or isinstance(item, str) for item in quick),
            f'{where}: invalid five-field MIDlet metadata')
    collections = set()
    crc_values = set()
    for i, source in enumerate(sources):
        context = f'{where} source {i}'
        require(isinstance(source, list) and len(source) == 4,
                f'{context}: invalid four-field source')
        collection, filename, archive_path, crc = source
        require(type(collection) is int and collection in (0, 1),
                f'{context}: invalid collection {collection!r}')
        require(isinstance(filename, str) and bool(filename),
                f'{context}: empty or invalid filename')
        require(isinstance(archive_path, str) and bool(archive_path),
                f'{context}: empty or invalid archive path')
        require(crc is None or (isinstance(crc, str) and
                (not crc or RE_CRC32.fullmatch(crc))),
                f'{context}: invalid CRC32 {crc!r}')
        collections.add(collection)
        if crc:
            crc_values.add(crc.lower())
    return sha256, sha1, collections, crc_values, expected_search_labels(sources, quick)


def validate_detail_rows(rows, record_id, collections):
    require(isinstance(rows, list), f'details for record ID {record_id}: expected list')
    for index, row in enumerate(rows):
        where = f'details for record ID {record_id}, entry {index}'
        require(isinstance(row, list) and len(row) == 4,
                f'{where}: expected [collection,fields,paths,path_count]')
        collection, fields, paths, path_count = row
        require(type(collection) is int and collection in collections,
                f'{where}: collection not present among the record sources')
        require(isinstance(fields, dict) and all(isinstance(k, str) for k in fields),
                f'{where}: invalid manifest field object')
        require(isinstance(paths, list) and all(isinstance(p, str) for p in paths),
                f'{where}: invalid original paths list')
        require(type(path_count) is int and path_count >= len(paths),
                f'{where}: original path count is smaller than published paths')


def gram_bits(names: list[str], shard: int, expected: dict):
    bit = 1 << shard
    for label in names:
        chars = list(label)  # Unicode code points, as in JS Array.from().
        for n in (2, 3):
            if len(chars) < n:
                continue
            # A repeated gram within a label only needs one bitmap bit.
            for gram in {''.join(chars[i:i+n]) for i in range(len(chars) - n + 1)}:
                mapping = expected[n]
                mapping[gram] = mapping.get(gram, 0) | bit


def validate_gram_map(raw, expected, chunks):
    require(isinstance(raw, dict) and all(isinstance(raw.get(str(n)), dict) for n in (2, 3)),
            'Invalid gram map: expected 2-gram and 3-gram objects')
    for n in (2, 3):
        actual = raw[str(n)]
        wanted = expected[n]
        for gram, encoded in actual.items():
            require(isinstance(gram, str) and len(gram) == n,
                    f'Invalid {n}-gram key {gram!r}')
            require(isinstance(encoded, str) and re.fullmatch(r'[0-9a-fA-F]+', encoded),
                    f'Invalid bitmap for {gram!r}')
            value = int(encoded, 16)
            require(value > 0 and value.bit_length() <= chunks,
                    f'Gram {gram!r} references an invalid name shard')
            require(gram in wanted, f'Gram {gram!r} refers to no actual name label')
            require(value == wanted[gram],
                    f'Gram bitmap mismatch for {gram!r}: indexed {value:x}, expected {wanted[gram]:x}')
        missing = wanted.keys() - actual.keys()
        require(not missing,
                f'{n}-gram map is missing {len(missing)} entries (e.g. {sorted(missing)[:3]})')


def check_full_index(data: Path, *, progress=False, temp_dir: Path | None = None) -> str:
    """Validate *all* core search data. Never modifies any file inside data/."""
    data = Path(data)
    manifest = read_json(data / 'manifest.json')
    require(isinstance(manifest, dict) and manifest.get('schema_version') == 4,
            'Expected schema_version 4 in data/manifest.json')
    require(manifest.get('schema') == SCHEMA, 'Unexpected record schema in manifest')
    require(manifest.get('source_schema') == SOURCE_SCHEMA, 'Unexpected source schema in manifest')
    count = manifest.get('unique_files')
    chunk = manifest.get('record_chunk')
    chunks = manifest.get('names_chunks')
    require(type(count) is int and count > 0, 'Invalid unique_files count')
    require(type(chunk) is int and chunk > 0, 'Invalid record_chunk size')
    require(type(chunks) is int and chunks > 0, 'Invalid names_chunks count')
    gram_path = manifest.get('names_grams')
    require(isinstance(gram_path, str) and gram_path.endswith('/grams.json.gz') and
            all(part and part not in ('.', '..') and '\\' not in part
                for part in gram_path.split('/')),
            'Invalid names_grams path')
    name_dir = data / gram_path.rsplit('/', 1)[0]
    record_shards = (count + chunk - 1) // chunk
    numbered = {f'{i:04d}.json.gz' for i in range(record_shards)}
    for kind in ('records', 'details'):
        check_files(data / kind, numbered, label=kind)
    for kind in ('crc32', 'sha1', 'sha256'):
        check_files(data / kind, {f'{letter}.json.gz' for letter in HEX}, label=kind)
    name_files = {p.name for p in name_dir.glob('*.json.gz') if p.name != 'grams.json.gz'}
    require(bool(name_files), 'No name shards found')
    for filename in name_files:
        match = re.fullmatch(r'([0-9]{3,})\.json\.gz', filename)
        require(match is not None and int(match[1]) < chunks and
                filename == f'{int(match[1]):03d}.json.gz',
                f'Invalid name shard filename: {filename}')

    def log(message):
        if progress:
            print(message, flush=True)

    # Store expectations on disk, rather than loading 620k records and all
    # searchable strings into RAM. Each actual index row consumes an expectation;
    # missing and invented rows are both detected.
    with tempfile.TemporaryDirectory(prefix='j2me-index-check-', dir=temp_dir) as temp:
        db = sqlite3.connect(Path(temp) / 'expected.sqlite')
        try:
            db.executescript('''
                PRAGMA journal_mode=OFF;
                PRAGMA synchronous=OFF;
                CREATE TABLE records (
                    id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE,
                    sha1 TEXT NOT NULL UNIQUE
                );
                CREATE TABLE names (
                    id INTEGER NOT NULL, kind INTEGER NOT NULL, label TEXT NOT NULL,
                    PRIMARY KEY(id,kind,label)
                ) WITHOUT ROWID;
                CREATE TABLE crc32 (
                    crc TEXT NOT NULL, id INTEGER NOT NULL,
                    PRIMARY KEY(crc,id)
                ) WITHOUT ROWID;
            ''')
            counts = {'lite_only': 0, 'full_only': 0, 'shared_files': 0,
                      'lite_rows': 0, 'full_rows': 0}
            for shard in range(record_shards):
                path = data / 'records' / f'{shard:04d}.json.gz'
                records = read_json(path, gz=True)
                expected_rows = min(chunk, count - shard * chunk)
                require(isinstance(records, list) and len(records) == expected_rows,
                        f'{path}: expected {expected_rows} records')
                detail_path = data / 'details' / f'{shard:04d}.json.gz'
                details = read_json(detail_path, gz=True)
                require(isinstance(details, list) and len(details) == expected_rows,
                        f'{detail_path}: expected {expected_rows} detail rows')
                for offset, (record, detail) in enumerate(zip(records, details)):
                    record_id = shard * chunk + offset
                    sha256, sha1, collections, crcs, labels = validate_record(record, record_id)
                    validate_detail_rows(detail, record_id, collections)
                    try:
                        db.execute('INSERT INTO records VALUES (?,?,?)', (record_id, sha256, sha1))
                    except sqlite3.IntegrityError as exc:
                        raise FullIndexError(f'record ID {record_id}: duplicate SHA checksum: {exc}') from exc
                    db.executemany('INSERT INTO names VALUES (?,?,?)',
                                   ((record_id, kind, label) for kind, label in labels))
                    db.executemany('INSERT INTO crc32 VALUES (?,?)',
                                   ((crc, record_id) for crc in crcs))
                    if collections == {0, 1}:
                        counts['shared_files'] += 1
                    elif collections == {0}:
                        counts['lite_only'] += 1
                    else:
                        counts['full_only'] += 1
                    for source in record[3]:
                        counts['lite_rows' if source[0] == 0 else 'full_rows'] += 1
                db.commit()
                if (shard + 1) % 20 == 0 or shard + 1 == record_shards:
                    log(f'Validated records/details: {shard + 1}/{record_shards} shards')

            for field in ('lite_only', 'full_only', 'shared_files', 'lite_rows', 'full_rows'):
                if field in manifest:
                    require(type(manifest[field]) is int and manifest[field] == counts[field],
                            f'Manifest {field}={manifest[field]!r}, computed {counts[field]}')
            if 'total_rows' in manifest:
                source_rows = counts['lite_rows'] + counts['full_rows']
                require(type(manifest['total_rows']) is int and manifest['total_rows'] == source_rows,
                        f'Manifest total_rows={manifest["total_rows"]!r}, computed {source_rows}')

            seen_sha1 = bytearray(count)
            seen_sha256 = bytearray(count)
            for kind, length in (('crc32', 8), ('sha1', 40), ('sha256', 64)):
                number = 0
                for bucket in HEX:
                    path = data / kind / f'{bucket}.json.gz'
                    index = read_json(path, gz=True)
                    require(isinstance(index, dict), f'{path}: expected checksum-to-ID object')
                    for key, stored in index.items():
                        require(isinstance(key, str) and len(key) == length and
                                re.fullmatch(r'[0-9a-f]+', key) and key[0] == bucket,
                                f'{path}: invalid {kind} key/bucket {key!r}')
                        if kind == 'crc32':
                            require(isinstance(stored, list) and bool(stored),
                                    f'{path} {key}: expected a nonempty list of IDs')
                            for record_id in stored:
                                require(valid_id(record_id, count), f'{path} {key}: invalid ID {record_id!r}')
                                deleted = db.execute('DELETE FROM crc32 WHERE crc=? AND id=?',
                                                     (key, record_id)).rowcount
                                require(deleted == 1,
                                        f'{path} {key}: unexpected or duplicate record ID {record_id}')
                                number += 1
                        else:
                            require(valid_id(stored, count), f'{path} {key}: invalid ID {stored!r}')
                            found = db.execute('SELECT sha1,sha256 FROM records WHERE id=?',
                                               (stored,)).fetchone()
                            require(found is not None and found[0 if kind == 'sha1' else 1] == key,
                                    f'{path} {key}: ID {stored} has a different {kind}')
                            seen = seen_sha1 if kind == 'sha1' else seen_sha256
                            require(not seen[stored], f'{path}: duplicate {kind} lookup for ID {stored}')
                            seen[stored] = 1
                            number += 1
                if kind == 'crc32':
                    leftover = db.execute('SELECT crc,id FROM crc32 LIMIT 1').fetchone()
                    if leftover is not None:
                        raise FullIndexError(f'CRC32 lookup missing source checksum {leftover[0]} '
                                             f'for record ID {leftover[1]}')
                else:
                    require(number == count and all(seen_sha1 if kind == 'sha1' else seen_sha256),
                            f'{kind} index covers {number} of {count} records')
                log(f'Validated {kind} lookups: {number:,} entries')

            expected_grams = {2: {}, 3: {}}
            name_entries = 0
            name_shards = sorted(name_files)
            for filename in name_shards:
                shard = int(filename.split('.')[0])
                path = name_dir / filename
                rows = read_json(path, gz=True)
                require(isinstance(rows, list) and rows, f'{path}: expected nonempty name entries')
                labels = []
                for row in rows:
                    require(isinstance(row, list) and len(row) == 3,
                            f'{path}: invalid name-index row {row!r}')
                    label, record_id, kind = row
                    require(isinstance(label, str) and label and label == label_text(label),
                            f'{path}: invalid/non-normalized name label {label!r}')
                    require(valid_id(record_id, count) and type(kind) is int and kind in (0, 1, 2),
                            f'{path}: invalid record ID or label kind {row!r}')
                    deleted = db.execute('DELETE FROM names WHERE id=? AND kind=? AND label=?',
                                         (record_id, kind, label)).rowcount
                    require(deleted == 1,
                            f'{path}: unexpected/duplicate name {label!r}, ID {record_id}, kind {kind}')
                    labels.append(label)
                    name_entries += 1
                gram_bits(labels, shard, expected_grams)
                db.commit()
            missing_label = db.execute('SELECT id,kind,label FROM names LIMIT 1').fetchone()
            if missing_label is not None:
                raise FullIndexError(f'Name index missing label {missing_label[2]!r} for record ID '
                                     f'{missing_label[0]}, kind {missing_label[1]}')
            log(f'Validated name labels: {name_entries:,} entries in {len(name_shards)} shards')
            if 'search_terms' in manifest:
                require(type(manifest['search_terms']) is int and
                        manifest['search_terms'] == name_entries,
                        f'Manifest search_terms={manifest["search_terms"]!r}, counted {name_entries}')
            validate_gram_map(read_json(data / gram_path, gz=True), expected_grams, chunks)
            log(f'Validated complete 2/3-gram map: '
                f'{len(expected_grams[2]):,} / {len(expected_grams[3]):,} entries')
        finally:
            db.close()

    return (f'Full index validation passed: {count:,} records and details across '
            f'{record_shards:,} shards, {name_entries:,} name entries in '
            f'{len(name_shards)} shards, all SHA-1/SHA-256/CRC32 lookups '
            f'and complete 2/3-gram bitmaps.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    paths = parser.add_mutually_exclusive_group()
    paths.add_argument('--repo', type=Path, default=Path.cwd(),
                       help='Repository root containing data/ (default: current directory)')
    paths.add_argument('--data', type=Path, help='Generated data/ directory')
    parser.add_argument('--temp-dir', type=Path,
                        help='Existing directory for temporary SQLite files (default: system temp)')
    args = parser.parse_args()
    data = args.data if args.data is not None else args.repo / 'data'
    try:
        print(check_full_index(data, progress=True, temp_dir=args.temp_dir))
    except (FullIndexError, sqlite3.Error, OSError, OverflowError) as error:
        print(f'Full index validation FAILED: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
