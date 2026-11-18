#!/usr/bin/env python3
"""Build optional 96x65pixels mini direct-JAR URL lookups keyed by SHA-1.

Reads mini_sha1_manifest.csv; does not change core search indexes or records.
The IA viewer treats the complete inner 7z member path as ONE URL component.
"""
import argparse
import csv
import gzip
import json
import os
import re
from pathlib import Path
from urllib.parse import quote, quote_from_bytes

MINI_ID = '96x65pixels_j2me_mini'
EXPECTED_PACKAGES = {
    '#.7z', 'A-B.7z', 'C-D.7z', 'E-G.7z', 'H-L.7z',
    'M-O.7z', 'P-R.7z', 'S.7z', 'T-Z.7z',
}
SURROGATES = re.compile(r'\\udc[89a-f][0-9a-f]', re.I)
HASH_RE = re.compile(r'[0-9a-f]{40}', re.I)
SHA256_RE = re.compile(r'[0-9a-f]{64}', re.I)
CRC_RE = re.compile(r'[0-9a-f]{8}', re.I)
MINI_COLLECTION = '96x65pixels J2ME mini'


def filename_bytes(text):
    """Undo ASCII escape sequences written by errors='backslashreplace'."""
    path = SURROGATES.sub(lambda m: chr(int(m.group()[2:], 16)), text)
    return os.fsencode(path)


def build(manifest: Path, out: Path, expected_rows: int = 225867,
          catalog=None):
    # Optional check against the final v2 CSV so no bogus hash mapping ships.
    known = None
    mini_only = None
    if catalog:
        known = set()
        mini_only = {}
        with catalog.open('r', encoding='utf-8-sig', errors='surrogateescape', newline='') as f:
            reader = csv.DictReader(f)
            if not {'sha1', 'sha256', 'collection', 'size_bytes', 'crc32'}.issubset(reader.fieldnames or []):
                raise ValueError('v2 CSV is missing hash, collection, size, or CRC columns')
            for r in reader:
                h = r['sha1'].lower()
                if not HASH_RE.fullmatch(h):
                    raise ValueError('Invalid SHA-1 in v2 CSV')
                known.add(h)
                if r['collection'] == MINI_COLLECTION:
                    sha256, crc = r['sha256'].lower(), r['crc32'].upper()
                    size = int(r['size_bytes'])
                    if (not SHA256_RE.fullmatch(sha256) or not CRC_RE.fullmatch(crc)
                            or size <= 0 or h in mini_only):
                        raise ValueError('Malformed or duplicate Mini-only entry in v2 CSV')
                    mini_only[h] = (sha256, size, crc)
    shards = {}
    packages = set()
    count = 0
    mini_routes = {}
    with manifest.open('r', encoding='utf-8', newline='') as f:
        reader = csv.DictReader(f)
        required = {'sha1', 'archive', 'internal_path', 'filename', 'size_bytes'}
        if not required.issubset(set(reader.fieldnames or [])):
            raise ValueError(f'Missing mini manifest fields: {required - set(reader.fieldnames or [])}')
        for r in reader:
            sha1 = r['sha1'].lower()
            archive = r['archive']
            path = r['internal_path']
            if not HASH_RE.fullmatch(sha1):
                raise ValueError(f'Invalid SHA-1 at row {count+2}: {sha1!r}')
            if archive not in EXPECTED_PACKAGES:
                raise ValueError(f'Unexpected 7z package: {archive!r}')
            if not path or not path.lower().endswith('.jar') or int(r['size_bytes']) <= 0:
                raise ValueError(f'Invalid JAR path or size at row {count+2}')
            if known is not None and sha1 not in known:
                raise ValueError(f'Mini SHA-1 not in v2 CSV: {sha1}')
            b = sha1[:2]
            group = shards.setdefault(b, {})
            if sha1 in group:
                raise ValueError(f'Duplicate mini SHA-1: {sha1}')
            # Preserve original escaped text for display; make the URL from
            # real filename bytes. '/' is encoded as %2F within a 7z member.
            tail = quote(archive, safe='') + '/' + quote_from_bytes(filename_bytes(path), safe='')
            group[sha1] = [archive, path, tail]
            if mini_only is not None and sha1 in mini_only:
                sha256, expected_size, crc = mini_only[sha1]
                if int(r['size_bytes']) != expected_size:
                    raise ValueError(f'Mini-only size differs between inventories: {sha1}')
                mini_routes[sha256] = [sha1, tail, expected_size, crc]
            packages.add(archive)
            count += 1
    if count != expected_rows:
        raise ValueError(f'Expected {expected_rows:,} JARs but saw {count:,}')
    if expected_rows == 225867 and packages != EXPECTED_PACKAGES:
        raise ValueError(f'Missing archive packages: {EXPECTED_PACKAGES - packages}')
    if mini_only is not None and len(mini_routes) != len(mini_only):
        raise ValueError(f'Missing Mini-only paths: {len(mini_only) - len(mini_routes)}')
    if mini_only is None and (out / 'cli.json.gz').is_file():
        raise ValueError('Existing Mini CLI map needs --v2-csv for regeneration')
    out.mkdir(parents=True, exist_ok=True)
    # One compressed file per two-digit SHA-1 prefix (max ~1/256 of links
    # fetched on demand when opening a download disclosure).
    for bucket, data in shards.items():
        raw = json.dumps(data, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        (out / f'{bucket}.json.gz').write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    if mini_only is not None:
        # Small CLI fallback for the new Mini-only files. It does not alter the
        # legacy retrieval/v1 index, whose LZMA2 offsets cover Lite/Full only.
        cli = {
            'version': 1, 'item': MINI_ID,
            'sha256': dict(sorted(mini_routes.items())),
            'sha1': {r[0]: sha for sha, r in sorted(mini_routes.items())},
        }
        payload = json.dumps(cli, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        (out / 'cli.json.gz').write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
        print(f'Mini-only CLI lookup entries: {len(mini_routes):,}')
    (out / 'manifest.json').write_text(json.dumps({
        'version': 1, 'item': MINI_ID, 'rows': count, 'shards': len(shards),
        'packages': sorted(packages), 'hash': 'sha1', 'prefix_length': 2,
    }, indent=2) + '\n', encoding='utf-8')
    print(f'Mini JAR paths mapped: {count:,}')
    print(f'7z packages covered: {len(packages)}')
    print(f'SHA-1 buckets: {len(shards)}')
    print(f'Wrote optional mappings to: {out}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--v2-csv', type=Path,
                        help='Optionally check every mini SHA-1 occurs in final v2 CSV')
    parser.add_argument('--expected-rows', type=int, default=225867)
    args = parser.parse_args()
    build(args.manifest, args.out, args.expected_rows, args.v2_csv)


if __name__ == '__main__':
    main()
