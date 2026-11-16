#!/usr/bin/env python3
"""Verify that data/folders/ was built from the exact current web records.

Unlike the fast general index smoke check, this reads EVERY record shard. Use
before publishing a rebuilt index. Python 3, standard library only.

    python3 tools/check_folder_index.py --repo .
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys

from folder_fingerprint import update_record_digest


class FolderIndexError(ValueError):
    """Folder index is absent, obsolete, malformed, or mismatched."""


def positive_int(value, name):
    if type(value) is not int or value <= 0:
        raise FolderIndexError(f'Invalid {name}: {value!r}')
    return value


def check_folder_index(repo: Path, *, require_folders=False) -> str:
    data = Path(repo) / 'data'
    folder_manifest = data / 'folders' / 'manifest.json'
    if not folder_manifest.is_file():
        if require_folders:
            raise FolderIndexError('Folder index absent: run python3 tools/build_folder_groups.py --repo .')
        return 'Folder index absent: optional compatibility check skipped.'

    main_manifest = data / 'manifest.json'
    if not main_manifest.is_file():
        raise FolderIndexError(f'Missing {main_manifest}')
    try:
        main_bytes = main_manifest.read_bytes()
        main = json.loads(main_bytes)
        folder = json.loads(folder_manifest.read_bytes())
    except (OSError, UnicodeError, ValueError) as error:
        raise FolderIndexError(f'Cannot read index manifests: {error}') from error
    if not isinstance(main, dict) or main.get('schema_version') != 4:
        raise FolderIndexError('Expected web index schema_version 4')
    if not isinstance(folder, dict) or folder.get('schema_version') != 2:
        raise FolderIndexError('Obsolete folder index: rebuild data/folders/ with the new builder')

    count = positive_int(main.get('unique_files'), 'unique_files')
    chunk = positive_int(main.get('record_chunk'), 'record_chunk')
    if folder.get('unique_files') != count or folder.get('record_chunk') != chunk:
        raise FolderIndexError('Folder index counts/chunk size differ from the web index')
    if folder.get('index_manifest_sha256') != hashlib.sha256(main_bytes).hexdigest():
        raise FolderIndexError('Folder index was built from a different data/manifest.json')
    expected = folder.get('records_sha256')
    if not isinstance(expected, str) or re.fullmatch(r'[0-9a-f]{64}', expected) is None:
        raise FolderIndexError('Folder index is missing a valid records_sha256 fingerprint')

    shard_count = (count + chunk - 1) // chunk
    digest = hashlib.sha256()
    for index in range(shard_count):
        path = data / 'records' / f'{index:04d}.json.gz'
        try:
            with gzip.open(path, 'rt', encoding='utf-8') as stream:
                rows = json.load(stream)
        except (OSError, EOFError, UnicodeError, ValueError) as error:
            raise FolderIndexError(f'Cannot read {path}: {error}') from error
        expected_rows = min(chunk, count - index * chunk)
        if not isinstance(rows, list) or len(rows) != expected_rows:
            raise FolderIndexError(f'{path}: expected {expected_rows} records')
        for record in rows:
            update_record_digest(digest, record)

    actual = digest.hexdigest()
    if actual != expected:
        raise FolderIndexError(
            'Folder index incompatible with current record contents/ID assignments. '
            'Regenerate it: python3 tools/build_folder_groups.py --repo . '
            f'(expected {expected[:16]}…, actual {actual[:16]}…)')
    return f'Folder index compatibility passed: {count:,} records across {shard_count} shards.'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd(), help='Repository root')
    parser.add_argument('--require-folders', action='store_true', help='Fail if folder data is absent')
    args = parser.parse_args()
    try:
        print(check_folder_index(args.repo, require_folders=args.require_folders))
    except (FolderIndexError, OSError, ValueError) as error:
        print(f'Folder index check FAILED: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
