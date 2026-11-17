#!/usr/bin/env python3
"""Diagnose *why* two validated J2ME core indexes have different file hashes.

This is a read-only layout/serialization diagnostic, not an integrity validator.
Run the exhaustive validator separately on both directories. It compares
manifest and build-summary fields, name shard boundaries, and the complete
ordered stream of searchable [label, record ID, kind] entries, while using
only one decompressed name shard per directory in memory at a time.

  python3 tools/compare_index_layout.py --existing data \\
      --rebuilt "$HOME/j2me-index-builds/rebuilt-data-01"

If the same record/details shards pass the full validator in both directories,
then their *sets* of searchable name entries must agree even if the global
order and/or shard boundaries differ. A different gram map is expected when
names land in different shards. No source files are modified.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
from itertools import zip_longest
import json
from pathlib import Path
import sys


class LayoutError(ValueError):
    """Missing or malformed input index."""


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise LayoutError(f'Cannot load {path}: {exc}') from exc


def differing_fields(left, right):
    """Return {key: (left_value, right_value)} for top-level JSON differences."""
    if not isinstance(left, dict) or not isinstance(right, dict):
        raise LayoutError('Expected JSON objects for manifest and summary')
    return {key: (left.get(key, '<absent>'), right.get(key, '<absent>'))
            for key in sorted(left.keys() | right.keys())
            if key not in left or key not in right or left[key] != right[key]}


def name_rows(root: Path, chunks: int, stats: dict):
    """Yield name entries across shards, recording per-shard sizes and edges."""
    for shard in range(chunks):
        path = root / 'names-v2' / f'{shard:03d}.json.gz'
        try:
            with gzip.open(path, 'rt', encoding='utf-8') as stream:
                rows = json.load(stream)
        except (OSError, EOFError, UnicodeError, ValueError) as exc:
            raise LayoutError(f'Cannot load {path}: {exc}') from exc
        if not isinstance(rows, list):
            raise LayoutError(f'{path}: expected list of name entries')
        stats['sizes'].append(len(rows))
        if shard in stats['sample_shards']:
            stats['samples'][shard] = {
                'first': rows[:2], 'last': rows[-2:], 'size': len(rows)
            }
        for offset, row in enumerate(rows):
            if not isinstance(row, list) or len(row) != 3:
                raise LayoutError(f'{path}, row {offset}: invalid name entry')
            stats['total'] += 1
            yield tuple(row)


def compare_name_streams(existing: Path, rebuilt: Path, left_chunks: int,
                         right_chunks: int, *, example_limit=4):
    """Compare ordered rows ignoring shard boundaries; bounded RAM usage."""
    samples = {0, 1, 2, 3, left_chunks // 2, left_chunks - 1,
               right_chunks // 2, right_chunks - 1}
    left_stats = {'total': 0, 'sizes': [], 'samples': {}, 'sample_shards': samples}
    right_stats = {'total': 0, 'sizes': [], 'samples': {}, 'sample_shards': samples}
    missing = object()
    mismatches = 0
    examples = []
    for position, (left, right) in enumerate(zip_longest(
            name_rows(existing, left_chunks, left_stats),
            name_rows(rebuilt, right_chunks, right_stats), fillvalue=missing)):
        if left != right:
            mismatches += 1
            if len(examples) < example_limit:
                examples.append((position, None if left is missing else left,
                                 None if right is missing else right))
    return {'left': left_stats, 'right': right_stats,
            'sequence_mismatches': mismatches, 'examples': examples,
            'same_boundaries': left_stats['sizes'] == right_stats['sizes']}


def summarize_sizes(sizes):
    return ', '.join(f'{size}: {count}' for size, count in sorted(Counter(sizes).items()))


def short(value, max_chars=160):
    result = repr(value)
    return result if len(result) <= max_chars else result[:max_chars] + '…'


def diagnose(existing: Path, rebuilt: Path, *, output=print):
    existing, rebuilt = Path(existing), Path(rebuilt)
    manifests = (load_json(existing / 'manifest.json'),
                 load_json(rebuilt / 'manifest.json'))
    summaries = (load_json(existing / 'build-summary.json'),
                 load_json(rebuilt / 'build-summary.json'))
    for title, pair in (('manifest.json', manifests), ('build-summary.json', summaries)):
        differences = differing_fields(*pair)
        output(f'\n=== {title}: {len(differences)} differing fields ===')
        for key, (left, right) in differences.items():
            output(f'  {key}:')
            output(f'    existing: {short(left)}')
            output(f'    rebuilt:  {short(right)}')
        if not differences:
            output('  Identical JSON objects.')
    try:
        left_chunks = manifests[0]['names_chunks']
        right_chunks = manifests[1]['names_chunks']
        if not (type(left_chunks) is int and 0 < left_chunks <= 9999 and
                type(right_chunks) is int and 0 < right_chunks <= 9999):
            raise KeyError('names_chunks')
    except (KeyError, TypeError) as exc:
        raise LayoutError('Both manifests need valid names_chunks') from exc

    output('\nComparing all name entries in their published order...')
    report = compare_name_streams(existing, rebuilt, left_chunks, right_chunks)
    output(f"  Existing: {report['left']['total']:,} entries in {left_chunks:,} shards")
    output(f"  Rebuilt:  {report['right']['total']:,} entries in {right_chunks:,} shards")
    output(f"  Existing shard sizes (rows: shards): {summarize_sizes(report['left']['sizes'])}")
    output(f"  Rebuilt shard sizes (rows: shards):  {summarize_sizes(report['right']['sizes'])}")
    output(f"  Same shard boundaries: {'yes' if report['same_boundaries'] else 'NO'}")
    output(f"  Different entries at the same position: {report['sequence_mismatches']:,}")
    for position, left, right in report['examples']:
        output(f'  First mismatching position {position:,}:')
        output(f'    existing: {short(left)}')
        output(f'    rebuilt:  {short(right)}')
    output('\nSelected shard edges:')
    for shard in sorted(report['left']['samples'].keys() | report['right']['samples'].keys()):
        left = report['left']['samples'].get(shard)
        right = report['right']['samples'].get(shard)
        if left is None or right is None:
            continue
        if left == right:
            continue
        output(f'  Shard {shard:03d}:')
        for title, edge in (('existing', left), ('rebuilt ', right)):
            output(f"    {title}: rows={edge['size']:,}, first={short(edge['first'][:1], 90)}, "
                   f"last={short(edge['last'][-1:], 90)}")

    if report['sequence_mismatches'] == 0 and not report['same_boundaries']:
        output('\nDIAGNOSIS: Name rows have the same global order; only shard boundaries differ.')
    elif report['sequence_mismatches'] == 0:
        output('\nDIAGNOSIS: Name rows and shard boundaries agree. Differences are in JSON bytes/encoding.')
    else:
        output('\nDIAGNOSIS: Name-row order differs. If both full validators passed and '
               'record shards match, this is a layout/order difference, not a missing-name difference.')
    output('The n-gram bitmap is shard-number-dependent and need not have the same bytes.')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--existing', type=Path, default=Path('data'))
    parser.add_argument('--rebuilt', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        diagnose(args.existing, args.rebuilt)
    except (LayoutError, OSError, TypeError) as exc:
        print(f'Comparison FAILED: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
