#!/usr/bin/env python3
"""Fast pre-deployment smoke check for generated search-index assets.

Requires the complete data/ directory; unlike check_repo.py, this intentionally
fails on source-only checkouts. It checks filenames/counts and samples gzip JSON,
not every record or the optional folder/upstream indexes.

Run: python3 tests/check_index.py [--data PATH]
"""

import argparse
import gzip
import json
import re
import sys
from pathlib import Path

DEFAULT_DATA = Path(__file__).resolve().parents[1] / 'data'
HEX_BUCKETS = '0123456789abcdef'


class IndexCheckError(Exception):
    """A required generated index asset is missing, inconsistent, or unreadable."""


def json_file(path, compressed=False):
    try:
        if compressed:
            with gzip.open(path, 'rt', encoding='utf-8') as stream:
                return json.load(stream)
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, EOFError, UnicodeError, ValueError) as error:
        raise IndexCheckError(f'Cannot read {path}: {error}') from error


def positive_int(value, field):
    if type(value) is not int or value <= 0:
        raise IndexCheckError(f'Invalid {field} in data/manifest.json: {value!r}')
    return value


def assert_shards(directory, expected):
    """Check both missing files and unexpected extra shards without reading them."""
    found = {file.name for file in directory.glob('*.json.gz')}
    missing = sorted(expected - found)
    extra = sorted(found - expected)
    if missing or extra:
        examples = []
        if missing:
            examples.append(f'{len(missing)} missing (e.g. {", ".join(missing[:3])})')
        if extra:
            examples.append(f'{len(extra)} unexpected (e.g. {", ".join(extra[:3])})')
        raise IndexCheckError(f'{directory}: ' + '; '.join(examples))


def sample_paths(paths):
    """First/middle/last; constant-size decompression as the archive grows."""
    if not paths:
        raise IndexCheckError('No shards available to sample')
    return [paths[i] for i in sorted({0, len(paths) // 2, len(paths) - 1})]


def check_index(data):
    data = Path(data)
    manifest = json_file(data / 'manifest.json')
    if not isinstance(manifest, dict) or manifest.get('schema_version') != 4:
        raise IndexCheckError('Expected schema_version 4 in data/manifest.json')
    total = positive_int(manifest.get('unique_files'), 'unique_files')
    record_chunk = positive_int(manifest.get('record_chunk'), 'record_chunk')
    names_chunks = positive_int(manifest.get('names_chunks'), 'names_chunks')
    names_grams = manifest.get('names_grams')
    # The browser uses the directory containing names-v2/grams.json.gz to find
    # each indexed name shard. Keep this check in sync with nameIndexConfig().
    if (not isinstance(names_grams, str) or not names_grams.endswith('/grams.json.gz')
            or not names_grams.split('/')[:-1]
            or any(part in ('', '.', '..') or '\\' in part
                   for part in names_grams.split('/'))):
        raise IndexCheckError('Invalid names_grams path in data/manifest.json')
    names_directory = data / names_grams.rsplit('/', 1)[0]

    shard_count = (total + record_chunk - 1) // record_chunk
    numbered = {f'{i:04d}.json.gz' for i in range(shard_count)}
    for kind in ('records', 'details'):
        assert_shards(data / kind, numbered)
    hashes = {f'{h}.json.gz' for h in HEX_BUCKETS}
    for kind in ('crc32', 'sha1', 'sha256'):
        assert_shards(data / kind, hashes)

    # Some names-v2 buckets can be empty. names_chunks is the number of
    # *possible* buckets, NOT a guarantee that every shard is written.
    found_names = {file.name for file in names_directory.glob('*.json.gz')
                   if file.name != 'grams.json.gz'}
    if not found_names:
        raise IndexCheckError(f'No name shards in {names_directory}')
    for name in found_names:
        if not re.fullmatch(r'[0-9]{3,}\.json\.gz', name):
            raise IndexCheckError(f'Unexpected name shard: {names_directory / name}')
        index = int(name.split('.', 1)[0])
        if index >= names_chunks or f'{index:03d}.json.gz' != name:
            raise IndexCheckError(f'Name shard outside manifest range: {name}')

    grams = json_file(data / names_grams, compressed=True)
    if not isinstance(grams, dict) or not all(isinstance(grams.get(k), dict) and grams[k]
                                               for k in ('2', '3')):
        raise IndexCheckError('Invalid names gram map (expected nonempty 2- and 3-gram maps)')
    used = 0
    for gram_size in ('2', '3'):
        for encoded in grams[gram_size].values():
            if not isinstance(encoded, str) or not re.fullmatch('[0-9a-fA-F]+', encoded):
                raise IndexCheckError('Invalid name-shard bitmap in gram map')
            used |= int(encoded, 16)
    if used == 0 or used >> names_chunks:
        raise IndexCheckError('Name gram map references an invalid shard number')
    referenced = {f'{i:03d}.json.gz' for i in range(names_chunks) if used & (1 << i)}
    missing_names = sorted(referenced - found_names)
    if missing_names:
        raise IndexCheckError(f'{names_directory}: {len(missing_names)} referenced name shards missing '
                              f'(e.g. {", ".join(missing_names[:3])})')

    checked = 1  # names gram map
    for kind in ('records', 'details'):
        for path in sample_paths(sorted((data / kind).glob('*.json.gz'))):
            rows = json_file(path, compressed=True)
            shard = int(path.stem.split('.')[0])
            expected_rows = min(record_chunk, total - shard * record_chunk)
            if not isinstance(rows, list) or len(rows) != expected_rows:
                raise IndexCheckError(f'{path}: expected {expected_rows} rows, got '
                                      f'{len(rows) if isinstance(rows, list) else type(rows).__name__}')
            if kind == 'records' and (not rows or not isinstance(rows[0], list)
                                      or len(rows[0]) != 5):
                raise IndexCheckError(f'{path}: unexpected record structure')
            checked += 1
    for path in sample_paths(sorted(names_directory / name for name in found_names)):
        rows = json_file(path, compressed=True)
        if not isinstance(rows, list) or not rows:
            raise IndexCheckError(f'{path}: expected a nonempty list of name entries')
        checked += 1
    for kind in ('crc32', 'sha1', 'sha256'):
        for bucket in ('0', '7', 'f'):
            path = data / kind / f'{bucket}.json.gz'
            if not isinstance(json_file(path, compressed=True), dict):
                raise IndexCheckError(f'{path}: expected a hash-to-ID object')
            checked += 1

    return (f'Index smoke check passed: {total:,} files; '
            f'{shard_count} record shards, {shard_count} detail shards, '
            f'{len(found_names)} name shards ({len(referenced)} referenced), '
            f'48 hash shards; {checked} gzip JSON assets sampled.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=DEFAULT_DATA,
                        help='Directory containing manifest.json and generated shards')
    args = parser.parse_args()
    try:
        print(check_index(args.data))
    except IndexCheckError as error:
        print(f'Index smoke check FAILED: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
