#!/usr/bin/env python3
"""Read-only SHA-256 comparison of every core file in two J2ME indexes.

Separates exact byte matches from gzip-encoding differences, JSON text
ordering differences, and true per-file content differences. For names-v2,
Per-shard comparisons preserve the exact name order and shard boundaries.

    python3 tools/compare_core_hashes.py --existing data \
      --rebuilt "$HOME/j2me-index-builds/rebuilt-data-02"

No archive files, index files, or generated content are modified. The
supplementary folders/, upstream/, and search-summaries/ indexes have separate
builders and are deliberately not compared here.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import sys

CORE_DIRS = ('records', 'details', 'crc32', 'sha1', 'sha256', 'names-v2')
ROOT_FILES = ('manifest.json', 'build-summary.json')
KINDS = ('exact', 'gzip_only', 'json_equivalent', 'content_differs')


def inventory(root: Path):
    files = {}
    for directory in CORE_DIRS:
        folder = root / directory
        if not folder.is_dir():
            raise ValueError(f'Missing core index directory: {folder}')
        for path in folder.rglob('*'):
            if path.is_file():
                files[path.relative_to(root).as_posix()] = path
    for name in ROOT_FILES:
        path = root / name
        if not path.is_file():
            raise ValueError(f'Missing core index file: {path}')
        files[name] = path
    return files


def sha256(path: Path, *, decompress=False):
    digest = hashlib.sha256()
    opener = gzip.open if decompress else open
    with opener(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.digest()


def compare_file(a: Path, b: Path, name: str):
    if sha256(a) == sha256(b):
        return 'exact'
    compressed = name.endswith('.json.gz')
    if compressed and sha256(a, decompress=True) == sha256(b, decompress=True):
        return 'gzip_only'
    try:
        open_json = gzip.open if compressed else open
        with open_json(a, 'rt', encoding='utf-8') as src:
            left = json.load(src)
        with open_json(b, 'rt', encoding='utf-8') as src:
            right = json.load(src)
        if left == right:
            return 'json_equivalent'
    except (ValueError, UnicodeError, OSError, EOFError):
        pass
    return 'content_differs'


def compare(existing: Path, rebuilt: Path, *, example_limit=3, progress=False):
    left = inventory(Path(existing))
    right = inventory(Path(rebuilt))
    left_names, right_names = set(left), set(right)
    missing, extra = sorted(left_names - right_names), sorted(right_names - left_names)
    both = sorted(left_names & right_names)
    totals = Counter()
    per_group = defaultdict(Counter)
    examples = defaultdict(list)
    for index, name in enumerate(both, 1):
        kind = compare_file(left[name], right[name], name)
        group = name.split('/')[0]
        totals[kind] += 1
        per_group[group][kind] += 1
        if kind != 'exact' and len(examples[(group, kind)]) < example_limit:
            examples[(group, kind)].append(name)
        if progress and index % 250 == 0:
            print(f'  Compared {index:,}/{len(both):,} files...', flush=True)
    return {'total': len(both), 'counts': totals, 'by_group': dict(per_group),
            'examples': dict(examples), 'missing': missing, 'extra': extra}


def print_report(report):
    print('\n=== Complete core-index SHA-256 comparison ===')
    print(f"Files common to both:             {report['total']:,}")
    for kind, label in (
        ('exact', 'Exact SHA-256 matches'),
        ('gzip_only', 'Gzip bytes differ; payload same'),
        ('json_equivalent', 'JSON values match; encoding differs'),
        ('content_differs', 'Per-file content differs'),
    ):
        print(f"{label + ':':34} {report['counts'][kind]:,}")
    print(f"Missing from rebuilt:             {len(report['missing']):,}")
    print(f"Extra in rebuilt:                 {len(report['extra']):,}")
    print('\nBy core index group:')
    for group, count in sorted(report['by_group'].items()):
        print(f"  {group:22} " + ', '.join(
            f'{kind}={count[kind]}' for kind in KINDS if count[kind]))
    for key, names in sorted(report['examples'].items()):
        print(f"  Examples {key[0]} / {key[1]}: " + ', '.join(names))
    for label in ('missing', 'extra'):
        if report[label]:
            print(f"  First {label} files: {', '.join(report[label][:10])}")
    if not report['missing'] and not report['extra'] and report['counts']['exact'] == report['total']:
        print('\nPASS: all core files are byte-for-byte identical.')
    else:
        print('\nNot byte-identical. See group breakdown above. '
              'Matching JSON values or complete global name streams can still mean equivalent indexes.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--existing', type=Path, default=Path('data'))
    parser.add_argument('--rebuilt', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = compare(args.existing, args.rebuilt, progress=True)
    except (OSError, ValueError, EOFError) as exc:
        print(f'SHA comparison FAILED: {exc}', file=sys.stderr)
        return 1
    print_report(report)
    return 0


if __name__ == '__main__':
    sys.exit(main())
