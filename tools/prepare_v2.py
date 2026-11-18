#!/usr/bin/env python3
"""Create v2 build inputs from the published site index and mini-only JARs.

Never modifies the base index, mini CSV, extracted JARs, or v2 public CSV.
The resulting temporary enrichment is intended for tools/build_site.py.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import zipfile
import zlib

FIELDS = [
    'collection', 'filename', 'archive_path', 'size_bytes', 'crc32',
    'sha1', 'sha256', 'archive_file', 'metadata_status',
    'midlet_name', 'midlet_vendor', 'midlet_version', 'cldc', 'midp',
]
COLLECTIONS = ['JARchiveLite v11', 'JARchive v11', '96x65pixels J2ME mini']
ARCHIVES = ['JARchiveLite_v11.7z', 'JARchive_v11.7z']
MINI_PACKAGES = {'#.7z', 'A-B.7z', 'C-D.7z', 'E-G.7z', 'H-L.7z',
                 'M-O.7z', 'P-R.7z', 'S.7z', 'T-Z.7z'}
SHA1_RE = re.compile(r'[a-fA-F0-9]{40}\Z')
SHA256_RE = re.compile(r'[a-fA-F0-9]{64}\Z')
ESCAPED_BYTE = re.compile(r'\\udc([89a-fA-F][0-9a-fA-F])')


def restored(text: str) -> str:
    # The previously generated CSV uses backslashreplace for undecodable bytes.
    return ESCAPED_BYTE.sub(lambda m: chr(0xdc00 + int(m.group(1), 16)), text)


def displayable(text: str) -> str:
    # Lossless, JSON-safe representation of invalid filename bytes. For coll=2
    # the package name is stored as the first source-path component.
    return ''.join(f'%{ord(c)-0xdc00:02X}' if 0xdc80 <= ord(c) <= 0xdcff else c
                   for c in restored(text))


def verify_jar_bytes(path: Path, expected_sha1: str, expected_sha256: str,
                     expected_crc: str, expected_size: int) -> None:
    """Independently verify each new mini JAR against the source inventory."""
    sha1, sha256 = hashlib.sha1(), hashlib.sha256()
    crc, size = 0, 0
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            sha1.update(block)
            sha256.update(block)
            crc = zlib.crc32(block, crc)
            size += len(block)
    if size != expected_size or sha1.hexdigest() != expected_sha1 or \
            sha256.hexdigest() != expected_sha256 or f'{crc:08X}' != expected_crc.upper():
        raise ValueError(f'Mini JAR bytes do not match size/SHA-1/SHA-256/CRC32: {path}')


def manifest_from_jar(path: Path) -> dict:
    try:
        with zipfile.ZipFile(path) as jar:
            item = next((s for s in jar.namelist()
                         if s.upper() == 'META-INF/MANIFEST.MF'), None)
            if item is None:
                return {}
            raw = jar.read(item)
    except (OSError, ValueError, EOFError, RuntimeError, zipfile.BadZipFile):
        return {}
    try:
        decoded = raw.decode('utf-8')
    except UnicodeDecodeError:
        decoded = raw.decode('cp1252', errors='replace')
    lines = []
    for line in decoded.replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        if line.startswith(' ') and lines:
            lines[-1] += line[1:]
        else:
            lines.append(line)
    result = {}
    for line in lines:
        if ': ' in line:
            key, value = line.split(': ', 1)
            result[key] = value
    return result


def pick(manifest, *names):
    lowered = {key.lower(): value for key, value in manifest.items()}
    return next((lowered[name.lower()] for name in names
                 if lowered.get(name.lower())), '')


def write_line(gz, obj):
    gz.write(json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + '\n')


def build(base: Path, mini: Path, extracted: Path, out: Path,
          expected_base=620287, expected_extra=1428, expected_rows=816215):
    if out.exists():
        raise ValueError(f'Output already exists: {out} (will not overwrite)')
    manifest = json.loads((base / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('schema_version') != 4 or manifest.get('unique_files') != expected_base:
        raise ValueError('The reference index is not the expected v1 index')
    chunk = manifest['record_chunk']
    total = manifest['unique_files']
    with mini.open(encoding='utf-8-sig', newline='') as f:
        if set(csv.DictReader(f).fieldnames or ()) != set(FIELDS[:8]):
            raise ValueError('Expected the eight-column mini_only_enriched.csv')

    # Output never becomes visible until all validations have passed.
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.v2-enrichment-', dir=out.parent) as scratch:
        stage = Path(scratch)
        csv_file = stage / 'jarchive-enriched.csv'
        detail_file = stage / 'jarchive-enriched-details.jsonl.gz'
        seen_sha1 = set()
        seen_sha256 = set()
        base_rows = extra = 0
        with csv_file.open('w', encoding='utf-8', newline='') as dest, \
             gzip.open(detail_file, 'wt', encoding='utf-8', compresslevel=6) as details:
            writer = csv.DictWriter(dest, fieldnames=FIELDS)
            writer.writeheader()
            for shard_no in range((total + chunk - 1) // chunk):
                with gzip.open(base / 'records' / f'{shard_no:04d}.json.gz',
                               'rt', encoding='utf-8') as stream:
                    records = json.load(stream)
                with gzip.open(base / 'details' / f'{shard_no:04d}.json.gz',
                               'rt', encoding='utf-8') as stream:
                    all_details = json.load(stream)
                if len(records) != len(all_details):
                    raise ValueError(f'Shard {shard_no}: details/records count mismatch')
                for record, detail_set in zip(records, all_details):
                    sha256, sha1, size, sources, quick = record
                    if (not SHA256_RE.fullmatch(sha256) or not SHA1_RE.fullmatch(sha1) or
                            sha256 in seen_sha256 or sha1 in seen_sha1):
                        raise ValueError(f'Duplicate/invalid hash in reference index: {sha256}')
                    seen_sha256.add(sha256)
                    seen_sha1.add(sha1)
                    for source in sources:
                        coll, filename, path, crc = source
                        if coll not in (0, 1):
                            raise ValueError(f'Unexpected source collection in base: {coll}')
                        writer.writerow(dict(zip(FIELDS, [
                            COLLECTIONS[coll], filename, path, size, crc, sha1, sha256,
                            ARCHIVES[coll], 'matched', *quick,
                        ])))
                        base_rows += 1
                    actual = {entry[0] for entry in detail_set}
                    needed = {source[0] for source in sources}
                    if actual != needed:
                        raise ValueError(f'Details missing collection {needed-actual} for {sha256}')
                    for coll, raw, paths, all_path_count in detail_set:
                        write_line(details, {
                            'collection': COLLECTIONS[coll], 'sha256': sha256,
                            'manifest': raw, 'paths': paths,
                            'path_count': all_path_count,
                        })
                if (shard_no + 1) % 20 == 0:
                    print(f'Recovered {min((shard_no+1)*chunk,total):,} v1 records', flush=True)
            if len(seen_sha1) != expected_base or base_rows != expected_rows:
                raise ValueError(f'Unexpected v1 totals: {len(seen_sha1):,} unique, {base_rows:,} rows')
            print(f'Base recovered: {base_rows:,} source rows, {len(seen_sha1):,} unique', flush=True)
            with mini.open('r', encoding='utf-8-sig', newline='') as source:
                reader = csv.DictReader(source)
                for item in reader:
                    if item['collection'] != COLLECTIONS[2]:
                        raise ValueError('Wrong collection in mini CSV: ' + str(item['collection']))
                    sha1 = item['sha1'].lower()
                    sha256 = item['sha256'].lower()
                    if (not SHA1_RE.fullmatch(sha1) or not SHA256_RE.fullmatch(sha256) or
                            sha1 in seen_sha1 or sha256 in seen_sha256):
                        raise ValueError('Mini hash is duplicate or malformed: ' + sha1)
                    archive = item['archive_file']
                    if archive not in MINI_PACKAGES:
                        raise ValueError('Unknown mini package: ' + archive)
                    internal = restored(item['archive_path'])
                    if (not internal or internal.startswith('/') or '\\' in internal or
                            '..' in internal.split('/')):
                        raise ValueError('Unsafe mini internal path: ' + repr(internal))
                    jar = extracted / archive[:-3] / internal
                    if not jar.is_file():
                        raise ValueError('Missing extracted JAR: ' + repr(str(jar)))
                    verify_jar_bytes(jar, sha1, sha256, item['crc32'],
                                     int(item['size_bytes']))
                    # Mini source paths are package-prefixed in the web index;
                    # the original eight-column release CSV is not changed.
                    packaged_path = archive + '/' + displayable(item['archive_path'])
                    clean_filename = displayable(item['filename'])
                    raw = manifest_from_jar(jar)
                    quick = [pick(raw, key) for key in (
                        'MIDlet-Name', 'MIDlet-Vendor', 'MIDlet-Version',
                        'MicroEdition-Configuration', 'MicroEdition-Profile')]
                    writer.writerow(dict(zip(FIELDS, [
                        COLLECTIONS[2], clean_filename, packaged_path,
                        int(item['size_bytes']), item['crc32'].upper(), sha1, sha256,
                        archive, 'extracted' if raw else 'unavailable', *quick,
                    ])))
                    write_line(details, {
                        'collection': COLLECTIONS[2], 'sha256': sha256,
                        'manifest': raw, 'paths': [displayable(item['archive_path'])],
                        'path_count': 1,
                    })
                    seen_sha1.add(sha1)
                    seen_sha256.add(sha256)
                    extra += 1
                    if extra % 250 == 0:
                        print(f'Enriched {extra:,} mini JARs', flush=True)
        if extra != expected_extra:
            raise ValueError(f'Expected {expected_extra:,} new JARs; got {extra:,}')
        if len(seen_sha1) != expected_base + expected_extra:
            raise ValueError('Unexpected unique SHA-1 total')
        stage.rename(out)
    print(f'v2 enrichment ready: {out} ({base_rows + extra:,} source rows, '
          f'{len(seen_sha1):,} unique hashes)', flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-data', type=Path, required=True)
    p.add_argument('--mini-csv', type=Path, required=True)
    p.add_argument('--extracted', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    args = p.parse_args()
    try:
        build(args.base_data.expanduser().resolve(),
              args.mini_csv.expanduser().resolve(),
              args.extracted.expanduser().resolve(),
              args.out.expanduser().absolute())
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, csv.Error) as error:
        print(f'PREPARATION FAILED: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
