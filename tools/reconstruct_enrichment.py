#!/usr/bin/env python3
"""Reconstruct enriched build inputs from a VERIFIED published index and the original archive inventories.

This is a *reference-backed reconstruction*, not an independent SHA-1/SHA-256
hashing pass. It cross-checks archive member paths, byte sizes, and CRC32
against the already published index; Full archive filenames also contain their
SHA-256. It joins the original infofiles to restore complete original paths
where the link is unambiguous. A Lite CRC32 collision is NEVER guessed.

Inputs can be the original .7z files or previously captured text/JSON members.
Nothing is extracted from the giant JARchive archives to disk. Writes occur
only in a new output directory, after all joins and checks succeed.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
import csv
import gzip
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile

COLLECTIONS = ('JARchiveLite v11', 'JARchive v11')
ARCHIVES = ('JARchiveLite_v11.7z', 'JARchive_v11.7z')
INFO_MEMBERS = ('indexL3_filtered_formatted.json', 'index11_filtered_formatted.json')
COLUMNS = ('collection', 'filename', 'archive_path', 'size_bytes', 'crc32', 'sha1',
           'sha256', 'archive_file', 'metadata_status', 'midlet_name',
           'midlet_vendor', 'midlet_version', 'cldc', 'midp')
RE_SHA1 = re.compile(r'[0-9a-f]{40}\Z')
RE_SHA256 = re.compile(r'[0-9a-f]{64}\Z')
RE_CRC = re.compile(r'[0-9A-F]{8}\Z')
RE_FULL_NAME = re.compile(r'\(([0-9a-fA-F]{64})\)\.jar\Z', re.I)
JSON_CHUNK = 65536
MAX_JSON_VALUE = 128 * 1024 * 1024


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


@contextmanager
def read_source(path, *, member=None, listing=False):
    """Stream UTF-8 from a file or directly from one 7z member/listing."""
    path = Path(path).expanduser().resolve(strict=True)
    if path.suffix.lower() != '.7z':
        with path.open('r', encoding='utf-8-sig', newline='') as stream:
            yield stream
        return
    if listing:
        command = ['7z', 'l', '-slt', str(path)]
    else:
        command = ['7z', 'x', '-so', str(path), member]
    with tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        except FileNotFoundError as exc:
            raise ValueError('7z executable not found; install 7zip') from exc
        try:
            with io.TextIOWrapper(process.stdout, encoding='utf-8-sig', errors='strict',
                                  newline='') as stream:
                yield stream
            status = process.wait()
            if status != 0:
                errors.seek(0)
                detail = errors.read(1500).decode('utf-8', errors='replace')
                raise ValueError(f'7z failed (exit {status}): {" ".join(command)} {detail}')
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def json_object_pairs(stream):
    """Incrementally parse a large top-level JSON object, one value at a time.

    Only one value (max 128 MiB) is materialized. Unlike json.load(), this
    does not retain the 680 MiB Full infofile in memory.
    """
    decoder = json.JSONDecoder()
    buffer, position, eof = '', 0, False

    def peek():
        nonlocal buffer, position, eof
        if position >= len(buffer) and not eof:
            buffer = ''
            position = 0
            next_chunk = stream.read(JSON_CHUNK)
            if next_chunk:
                buffer = next_chunk
            else:
                eof = True
        return buffer[position] if position < len(buffer) else ''

    def whitespace():
        nonlocal position
        while peek() in (' ', '\t', '\r', '\n'):
            position += 1

    def value():
        nonlocal buffer, position, eof
        # Discard previous entries, retaining only the current JSON value.
        buffer = buffer[position:]
        position = 0
        while True:
            try:
                result, end = decoder.raw_decode(buffer, position)
                position = end
                return result
            except json.JSONDecodeError as exc:
                if eof:
                    raise ValueError('Malformed or truncated infofile JSON') from exc
                if len(buffer) >= MAX_JSON_VALUE:
                    raise ValueError('Infofile JSON value exceeds 128 MiB safety limit') from exc
                chunk = stream.read(JSON_CHUNK)
                if chunk:
                    buffer += chunk
                else:
                    eof = True

    whitespace()
    if peek() != '{':
        raise ValueError('Infofile JSON must be a top-level object')
    position += 1
    whitespace()
    if peek() == '}':
        position += 1
    else:
        while True:
            whitespace()
            key = value()
            if not isinstance(key, str):
                raise ValueError('Infofile JSON keys must be strings')
            whitespace()
            if peek() != ':':
                raise ValueError('Missing colon in infofile JSON')
            position += 1
            whitespace()
            item = value()
            yield key, item
            whitespace()
            delim = peek()
            if delim == '}':
                position += 1
                break
            if delim != ',':
                raise ValueError('Missing comma in infofile JSON')
            position += 1
    whitespace()
    if peek():
        raise ValueError('Trailing garbage after infofile JSON')


def jar_inventory(stream):
    """Read 7z 'l -slt' records, ignoring header and non-JAR entries."""
    started, fields = False, {}

    def finish():
        if not fields:
            return None
        path = fields.get('Path', '')
        if (not path.lower().endswith('.jar') or
                'D' in fields.get('Attributes', '')[:1]):
            return None
        size = fields.get('Size', '')
        crc = fields.get('CRC', '').upper()
        if not size.isdecimal() or not RE_CRC.fullmatch(crc):
            raise ValueError(f'Incomplete .jar inventory entry: {path!r}')
        return path, int(size), crc

    for line in stream:
        line = line.rstrip('\r\n')
        if not started:
            if line == '----------':
                started = True
            continue
        if not line:
            item = finish()
            if item is not None:
                yield item
            fields = {}
            continue
        if ' = ' in line:
            key, value = line.split(' = ', 1)
            # An unexpected Path without a blank separator must not overwrite.
            if key == 'Path' and fields:
                item = finish()
                if item is not None:
                    yield item
                fields = {}
            fields[key] = value
    item = finish()
    if item is not None:
        yield item
    if not started:
        raise ValueError('Not a valid 7z -slt inventory (missing separator)')


def create_db(db):
    db.executescript('''
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        CREATE TABLE contents (
          sha TEXT PRIMARY KEY, sha1 TEXT NOT NULL, size INTEGER NOT NULL,
          quick TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE members (
          coll INTEGER NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL,
          filename TEXT NOT NULL, crc TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(coll,path)) WITHOUT ROWID;
        CREATE INDEX member_sha ON members(coll,sha);
        CREATE INDEX member_crc ON members(coll,crc);
        CREATE TABLE details (
          coll INTEGER NOT NULL, sha TEXT NOT NULL,
          manifest TEXT NOT NULL, paths TEXT NOT NULL, path_count INTEGER NOT NULL,
          PRIMARY KEY(coll,sha)) WITHOUT ROWID;
        CREATE TABLE info (
          coll INTEGER NOT NULL, key TEXT NOT NULL, manifest TEXT NOT NULL,
          paths TEXT NOT NULL, PRIMARY KEY(coll,key)) WITHOUT ROWID;
    ''')


def import_published(db, data):
    manifest = json.loads((data / 'manifest.json').read_text(encoding='utf-8'))
    unique, chunk = manifest.get('unique_files'), manifest.get('record_chunk')
    if (manifest.get('schema_version') != 4 or not isinstance(unique, int) or
            unique < 1 or not isinstance(chunk, int) or chunk < 1):
        raise ValueError('Published index manifest has invalid version/count/chunk')
    counts = Counter()
    for shard in range((unique + chunk - 1) // chunk):
        recpath = data / 'records' / f'{shard:04d}.json.gz'
        detpath = data / 'details' / f'{shard:04d}.json.gz'
        with gzip.open(recpath, 'rt', encoding='utf-8') as fp:
            records = json.load(fp)
        with gzip.open(detpath, 'rt', encoding='utf-8') as fp:
            details = json.load(fp)
        if len(records) != len(details) or len(records) != min(chunk, unique - chunk*shard):
            raise ValueError(f'Mismatched published shard {shard}')
        for r, d in zip(records, details):
            if (len(r) != 5 or len(r[4]) != 5 or
                    not RE_SHA256.fullmatch(r[0]) or not RE_SHA1.fullmatch(r[1])):
                raise ValueError(f'Invalid published record in shard {shard}')
            sha, sha1, size, sources, quick = r
            db.execute('INSERT INTO contents VALUES (?,?,?,?)',
                       (sha, sha1, size, encoded(quick)))
            coll_set = set()
            for coll, filename, path, crc in sources:
                if (coll not in (0, 1) or not isinstance(path, str) or
                        not path or not filename or not RE_CRC.fullmatch(crc or '')):
                    raise ValueError(f'Invalid source for {sha}')
                if path.rsplit('/', 1)[-1] != filename:
                    raise ValueError(f'Source basename differs from filename: {path!r}')
                db.execute('INSERT INTO members(coll,path,sha,filename,crc) VALUES (?,?,?,?,?)',
                           (coll, path, sha, filename, crc))
                counts[coll] += 1
                coll_set.add(coll)
            seen = set()
            for detail in d:
                if not isinstance(detail, list) or len(detail) != 4:
                    raise ValueError(f'Invalid published details for {sha}')
                coll, fields, paths, total = detail
                if (coll not in coll_set or coll in seen or not isinstance(fields, dict)
                        or not isinstance(paths, list) or not isinstance(total, int)
                        or total < len(paths) or not all(isinstance(p, str) for p in paths)):
                    raise ValueError(f'Invalid detail for {sha}, collection {coll}')
                seen.add(coll)
                db.execute('INSERT INTO details VALUES (?,?,?,?,?)',
                           (coll, sha, encoded(fields), encoded(paths), total))
            if seen != coll_set:
                raise ValueError(f'Missing published collection details for {sha}')
        if (shard + 1) % 20 == 0:
            print(f'Imported {shard + 1} published record shards...', flush=True)
    if counts[0] != manifest.get('lite_rows') or counts[1] != manifest.get('full_rows'):
        raise ValueError('Published source counts do not match manifest')
    return manifest, counts


def verify_inventory(db, coll, path, expected_rows):
    count = 0
    with read_source(path, listing=True) as stream:
        for member_path, size, crc in jar_inventory(stream):
            # 7z lists use forward slash separators, as in the website index.
            if '\\' in member_path or member_path.startswith('/') or '..' in member_path.split('/'):
                raise ValueError(f'Unsafe or unsupported archive path: {member_path!r}')
            row = db.execute('''SELECT m.sha, m.filename, m.crc, m.verified, c.size
                                FROM members m JOIN contents c ON m.sha=c.sha
                                WHERE m.coll=? AND m.path=?''', (coll, member_path)).fetchone()
            if row is None:
                raise ValueError(f'Unrecognized {COLLECTIONS[coll]} archive member: {member_path!r}')
            sha, filename, expected_crc, verified, expected_size = row
            if verified:
                raise ValueError(f'Duplicate inventory member: {member_path!r}')
            if (member_path.rsplit('/', 1)[-1] != filename or expected_size != size or
                    expected_crc != crc):
                raise ValueError(f'Inventory mismatch: {member_path!r}: '
                                 f'size/CRC {size}/{crc} != {expected_size}/{expected_crc}')
            if coll == 1:
                match = RE_FULL_NAME.search(filename)
                if not match or match.group(1).lower() != sha:
                    raise ValueError(f'Full archive SHA-256 filename disagrees: {member_path!r}')
            db.execute('UPDATE members SET verified=1 WHERE coll=? AND path=?',
                       (coll, member_path))
            count += 1
            if count % 100000 == 0:
                print(f'Verified {count:,} members from {ARCHIVES[coll]}...', flush=True)
    if count != expected_rows:
        missing = db.execute('SELECT path FROM members WHERE coll=? AND verified=0 LIMIT 1',
                             (coll,)).fetchone()
        raise ValueError(f'{COLLECTIONS[coll]} has {count:,} verified JARs; expected '
                         f'{expected_rows:,}. First unmatched index path: {missing}')
    print(f'Verified {count:,} paths, sizes and CRC32s in {ARCHIVES[coll]}', flush=True)


def import_info(db, coll, source):
    stored, read = 0, 0
    with read_source(source, member=INFO_MEMBERS[coll]) as stream:
        for raw_key, data in json_object_pairs(stream):
            read += 1
            key = raw_key.upper() if coll == 0 else raw_key.lower()
            valid = RE_CRC.fullmatch(key) if coll == 0 else RE_SHA256.fullmatch(key)
            if not valid or not isinstance(data, dict):
                raise ValueError(f'Invalid {COLLECTIONS[coll]} infofile entry {raw_key!r}')
            paths = data.get('paths', [])
            if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
                raise ValueError(f'Invalid original paths in infofile entry {raw_key!r}')
            query = ('SELECT 1 FROM members WHERE coll=0 AND crc=? LIMIT 1' if coll == 0
                     else 'SELECT 1 FROM members WHERE coll=1 AND sha=? LIMIT 1')
            if db.execute(query, (key,)).fetchone() is not None:
                fields = {name: value for name, value in data.items() if name != 'paths'}
                try:
                    db.execute('INSERT INTO info VALUES (?,?,?,?)',
                               (coll, key, encoded(fields), encoded(paths)))
                except sqlite3.IntegrityError as exc:
                    raise ValueError(f'Duplicate infofile key: {raw_key!r}') from exc
                stored += 1
            if read % 100000 == 0:
                print(f'Imported {read:,} {COLLECTIONS[coll]} infofile keys...', flush=True)
    print(f'Read {read:,} infofile entries; {stored:,} match published sources '
          f'({COLLECTIONS[coll]})', flush=True)
    return read, stored


def comparable_manifest(value):
    """Mirror the builder's primitive-only, size-bounded manifest view."""
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, item in value.items():
        if isinstance(item, (str, int, float, bool)) and item is not None:
            result[str(key)[:120]] = str(item)[:4000]
    return result


def ambiguous_lite_crcs(db):
    """Find CRC32 values identifying more than one Lite SHA-256 in one indexed scan.

    Counting distinct SHA-256 separately for every Lite detail pair would do
    hundreds of thousands of extra SQL queries. The (coll,crc) index makes this
    grouped scan linear in the number of archived Lite members.
    """
    return {crc for (crc,) in db.execute('''SELECT crc
        FROM members INDEXED BY member_crc
        WHERE coll=0 GROUP BY crc HAVING MIN(sha) != MAX(sha)''')}


def detail_groups(db):
    """Yield each collection/SHA and its unique CRC32 in one indexed pass.

    Avoid SELECT COUNT(DISTINCT crc) per pair. SQLite may otherwise choose its
    (coll,crc) index to satisfy DISTINCT and end up scanning most of the members
    table for *each* SHA-256, effectively taking quadratic time on real data.
    """
    for coll, sha, minimum_crc, maximum_crc in db.execute('''
            SELECT coll,sha,MIN(crc),MAX(crc)
            FROM members INDEXED BY member_sha
            GROUP BY coll,sha ORDER BY coll,sha'''):
        if minimum_crc != maximum_crc:
            raise ValueError(f'Different CRC32 values for the same SHA-256 '
                             f'in {COLLECTIONS[coll]}: {sha}')
        yield coll, sha, minimum_crc


def choose_details(db, coll, sha, crc, *, strict, audit, lite_collisions):
    published = db.execute('SELECT manifest,paths,path_count FROM details WHERE coll=? AND sha=?',
                           (coll, sha)).fetchone()
    if published is None:
        raise ValueError(f'Missing published metadata details for {COLLECTIONS[coll]} {sha}')
    pub_manifest, pub_paths, pub_count = published
    pub_paths = json.loads(pub_paths)
    key = crc if coll == 0 else sha
    reason = None
    if coll == 0 and crc in lite_collisions:
        reason = 'ambiguous_lite_crc32'
    info = None if reason else db.execute('SELECT manifest,paths FROM info WHERE coll=? AND key=?',
                                          (coll, key)).fetchone()
    if info is None and reason is None:
        reason = 'missing_info_key'
    if reason is not None:
        audit[reason] += 1
        if strict:
            raise ValueError(f'{reason} for {COLLECTIONS[coll]} SHA-256 {sha}, key {key}')
        if len(pub_paths) != pub_count:
            raise ValueError(f'{reason} for {COLLECTIONS[coll]} SHA-256 {sha}: '
                             f'published {len(pub_paths)} of {pub_count} original paths; '
                             'cannot reconstruct the missing paths')
        audit['complete_published_fallback'] += 1
        return json.loads(pub_manifest), pub_paths
    manifest_text, all_paths_json = info
    original_paths = json.loads(all_paths_json)
    if original_paths[:len(pub_paths)] != pub_paths:
        raise ValueError(f'Infofile original-path prefix disagrees with published details: '
                         f'{COLLECTIONS[coll]} SHA-256 {sha}')
    if len(original_paths) != pub_count:
        raise ValueError(f'Infofile original-path count differs from published details: '
                         f'{COLLECTIONS[coll]} SHA-256 {sha}: '
                         f'{len(original_paths)} != {pub_count}')
    incoming_manifest = json.loads(manifest_text)
    known_manifest = json.loads(pub_manifest)
    # Preserve the manifest *actually published* in the validated index;
    # separately report discrepancies with upstream infofiles. This is a
    # reconstruction of the existing build inputs, not a metadata correction.
    if comparable_manifest(incoming_manifest) != comparable_manifest(known_manifest):
        audit['manifest_disagreement'] += 1
        if strict:
            raise ValueError(f'Infofile manifest disagrees with published details: '
                             f'{COLLECTIONS[coll]} SHA-256 {sha}')
    audit['infofile_paths_restored'] += 1
    return known_manifest, original_paths


def reconstruct(*, data: Path, full_archive: Path, lite_archive: Path,
                full_info: Path, lite_info: Path, out: Path, temp_dir=None,
                expected_rows=816215, expected_unique=620287, strict_info=False):
    data = Path(data).expanduser().resolve(strict=True)
    out = Path(out).expanduser().absolute()
    if out.exists() or out.is_symlink():
        raise ValueError(f'Refusing to overwrite existing output: {out}')
    if not out.parent.is_dir():
        raise ValueError(f'Output parent does not exist: {out.parent}')
    # Never create output inside the published data directory.
    if data == out or data in out.resolve().parents:
        raise ValueError('Output must be outside the existing published index')
    if temp_dir is not None:
        temp_dir = Path(temp_dir).expanduser().resolve(strict=True)
        if not temp_dir.is_dir():
            raise ValueError(f'Not a temporary directory: {temp_dir}')

    with tempfile.TemporaryDirectory(prefix='.j2me-enrichment-', dir=out.parent) as staged:
        stage = Path(staged)
        with tempfile.TemporaryDirectory(prefix='j2me-enrichment-db-', dir=temp_dir) as dbroot:
            db = sqlite3.connect(str(Path(dbroot) / 'join.sqlite'))
            try:
                create_db(db)
                manifest, counts = import_published(db, data)
                unique = manifest['unique_files']
                if expected_rows and sum(counts.values()) != expected_rows:
                    raise ValueError(f'Expected {expected_rows:,} archive members, '
                                     f'published data has {sum(counts.values()):,}')
                if expected_unique and unique != expected_unique:
                    raise ValueError(f'Expected {expected_unique:,} unique JARs, '
                                     f'published data has {unique:,}')
                db.commit()
                verify_inventory(db, 0, lite_archive, counts[0])
                verify_inventory(db, 1, full_archive, counts[1])
                db.commit()
                lite_read, lite_stored = import_info(db, 0, lite_info)
                full_read, full_stored = import_info(db, 1, full_info)
                db.commit()
                audit = Counter()
                audit.update({'unique_sha256_from_published_index': unique,
                              'lite_inventory_verified': counts[0],
                              'full_inventory_verified': counts[1],
                              'lite_info_keys_read': lite_read,
                              'full_info_keys_read': full_read,
                              'lite_info_keys_referenced': lite_stored,
                              'full_info_keys_referenced': full_stored})
                with (stage / 'jarchive-enriched.csv').open('w', encoding='utf-8',
                                                            newline='') as output:
                    writer = csv.DictWriter(output, fieldnames=COLUMNS, lineterminator='\n')
                    writer.writeheader()
                    for coll, path, sha, filename, crc, sha1, size, quick_text in db.execute('''
                            SELECT m.coll,m.path,m.sha,m.filename,m.crc,
                                   c.sha1,c.size,c.quick FROM members m
                            JOIN contents c ON m.sha=c.sha
                            ORDER BY m.coll,m.path'''):
                        quick = json.loads(quick_text)
                        writer.writerow(dict(collection=COLLECTIONS[coll], filename=filename,
                                             archive_path=path, size_bytes=size, crc32=crc,
                                             sha1=sha1, sha256=sha, archive_file=ARCHIVES[coll],
                                             metadata_status='matched', midlet_name=quick[0] or '',
                                             midlet_vendor=quick[1] or '',
                                             midlet_version=quick[2] or '', cldc=quick[3] or '',
                                             midp=quick[4] or ''))
                        audit['enriched_rows_written'] += 1
                        if audit['enriched_rows_written'] % 100000 == 0:
                            print(f'Wrote {audit["enriched_rows_written"]:,} enriched CSV rows...',
                                  flush=True)
                print(f'CSV complete: {audit["enriched_rows_written"]:,} rows.', flush=True)
                lite_collisions = ambiguous_lite_crcs(db)
                print(f'Checked Lite CRC32 ambiguity: {len(lite_collisions):,} '
                      'collision identifiers.', flush=True)
                print('Writing collection/content metadata details...', flush=True)
                details_file = stage / 'jarchive-enriched-details.jsonl.gz'
                with details_file.open('wb') as raw:
                    with gzip.GzipFile(filename='', mode='wb', fileobj=raw,
                                       compresslevel=6, mtime=0) as zipped:
                        for coll, sha, crc in detail_groups(db):
                            fields, paths = choose_details(db, coll, sha, crc, strict=strict_info,
                                                           audit=audit,
                                                           lite_collisions=lite_collisions)
                            payload = dict(sha256=sha, collection=COLLECTIONS[coll],
                                           manifest=fields, paths=paths)
                            zipped.write((encoded(payload) + '\n').encode('utf-8'))
                            audit['detail_pairs_written'] += 1
                            if audit['detail_pairs_written'] % 10000 == 0:
                                # Flush gzip so the staging file grows visibly
                                # during a full reconstruction run.
                                zipped.flush()
                                print(f'Wrote {audit["detail_pairs_written"]:,} '
                                      'collection/content detail pairs...', flush=True)
                print(f'Metadata details complete: {audit["detail_pairs_written"]:,} pairs.',
                      flush=True)
                db.commit()
                with (stage / 'reconstruction-audit.json').open('w', encoding='utf-8') as output:
                    json.dump({
                        'method': 'reference-backed; SHA-1/SHA-256 not rehashed from JAR bytes',
                        'original_paths': 'from infofiles when unambiguous; otherwise complete published paths',
                        'metadata': 'preserved from existing validated records/details',
                        'strict_info': strict_info,
                        'counts': dict(sorted(audit.items())),
                    }, output, ensure_ascii=False, indent=2, sort_keys=True)
                if (audit['enriched_rows_written'] != sum(counts.values()) or
                        audit['detail_pairs_written'] != db.execute('SELECT count(*) FROM details')
                        .fetchone()[0]):
                    raise ValueError('Reconstructed row/detail count disagreement')
            finally:
                db.close()
        if out.exists() or out.is_symlink():
            raise ValueError(f'Output appeared during construction: {out}')
        os.rename(stage, out)
    return dict(audit)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--data', type=Path, required=True, help='Existing, exhaustively validated data/ directory')
    p.add_argument('--full-archive', type=Path, required=True,
                   help='JARchive_v11.7z, or a saved 7z -slt listing text file')
    p.add_argument('--lite-archive', type=Path, required=True,
                   help='JARchiveLite_v11.7z, or a saved 7z -slt listing text file')
    p.add_argument('--full-info', type=Path, required=True,
                   help='JARchive_v11_infofiles.7z, or extracted index11_filtered_formatted.json')
    p.add_argument('--lite-info', type=Path, required=True,
                   help='JARchiveLite_v11_infofiles.7z, or extracted indexL3_filtered_formatted.json')
    p.add_argument('--out', type=Path, required=True, help='NEW output directory, must not already exist')
    p.add_argument('--temp-dir', type=Path, help='Existing directory for temporary SQLite files')
    p.add_argument('--expected-rows', type=int, default=816215, help='Default 816215; use 0 only for tests')
    p.add_argument('--expected-unique', type=int, default=620287, help='Default 620287; use 0 only for tests')
    p.add_argument('--strict-info', action='store_true',
                   help='Require an unambiguous matching infofile entry and matching manifest for every pair')
    args = p.parse_args(argv)
    try:
        result = reconstruct(data=args.data, full_archive=args.full_archive,
                             lite_archive=args.lite_archive, full_info=args.full_info,
                             lite_info=args.lite_info, out=args.out, temp_dir=args.temp_dir,
                             expected_rows=args.expected_rows,
                             expected_unique=args.expected_unique,
                             strict_info=args.strict_info)
    except (ValueError, OSError, sqlite3.Error, json.JSONDecodeError, UnicodeError) as exc:
        print(f'Reconstruction FAILED: {exc}', file=sys.stderr)
        return 1
    print(f'Complete: {result["enriched_rows_written"]:,} rows, '
          f'{result["detail_pairs_written"]:,} collection/content details.', flush=True)
    print(f'Candidate enrichment ready: {args.out}. No published index or archives changed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
