#!/usr/bin/env python3
"""Read-only, bounded-memory metadata-quality audit for the published J2ME index.

    python3 tools/audit_metadata.py --data ./data --out /path/to/NEW/report-directory

Reads the existing schema-4 record and detail shards, *not* original JAR bytes.
Writes an aggregate JSON report, a manifest-field inventory, a possible-extension
field inventory, and a small CSV of representative observations. No source file
is modified. Python 3.9+ standard library only.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
import gzip
import json
import os
from pathlib import Path
import re
import sys
import tempfile

FIELDS = ('name', 'vendor', 'version', 'cldc', 'midp')
MANIFEST_KEYS = {
    'name': 'midlet-name', 'vendor': 'midlet-vendor',
    'version': 'midlet-version', 'cldc': 'microedition-configuration',
    'midp': 'microedition-profile',
}
COLLECTIONS = ('JARchiveLite v11', 'JARchive v11')
# Discovery only. A matching key does NOT establish device compatibility.
EXTENSION_TERMS = (
    'screen', 'resolution', 'display', 'dimension', 'language',
    'locale', 'device', 'platform', 'compatib',
)
SAMPLE_COLUMNS = ('issue', 'field', 'record_id', 'sha256', 'collection',
                  'primary', 'manifest', 'note')


def nonblank(value):
    """Match the frontend's absent metadata semantics: trim empty strings."""
    return str(value or '').strip()


def comparable(value):
    return ' '.join(nonblank(value).casefold().split())


def compact(value, limit=160):
    result = str(value).replace('\n', ' ').replace('\r', ' ').strip()
    return result[:limit] + ('…' if len(result) > limit else '')


def read_json(path, *, gz=False):
    with (gzip.open(path, 'rt', encoding='utf-8') if gz
          else path.open('r', encoding='utf-8')) as stream:
        return json.load(stream)


def canonical_manifest(raw):
    """Normalize key casing; preserve conflicting differently cased values."""
    normalized = defaultdict(list)
    for name, value in raw.items():
        key = str(name).strip().casefold()
        if key:
            normalized[key].append(nonblank(value))
    return normalized


def audit(data: Path, *, max_examples=12, max_total_examples=500):
    """Return aggregate report and limited examples; never store all records."""
    if max_examples < 0 or max_total_examples < 0:
        raise ValueError('Example limits must not be negative')
    data = Path(data)
    manifest = read_json(data / 'manifest.json')
    if manifest.get('schema_version') != 4:
        raise ValueError('Expected schema-4 index manifest')
    count, chunk = manifest.get('unique_files'), manifest.get('record_chunk')
    if type(count) is not int or count < 1 or type(chunk) is not int or chunk < 1:
        raise ValueError('Invalid unique_files or record_chunk in manifest')

    primary = {field: Counter() for field in FIELDS}
    by_collection = {name: {'detail_pairs': 0, 'manifest_fields': {
        field: Counter() for field in FIELDS}} for name in COLLECTIONS}
    observations = {key: Counter() for key in (
        'source_crc_disagreement', 'missing_collection_detail',
        'duplicate_collection_detail', 'intra_manifest_conflict',
        'cross_collection_difference', 'primary_manifest_difference',
        'primary_missing_manifest_present', 'primary_missing_other_manifest_present',
    )}
    inventory = {}  # canonical key -> [with_key, with_nonblank_value, original spelling, example]
    examples = []
    example_counts = Counter()

    def observe(kind, field, id_, sha, collection='', primary_value='',
                manifest_value='', note=''):
        token = field or '(general)'
        observations[kind][token] += 1
        if len(examples) < max_total_examples and example_counts[(kind, token)] < max_examples:
            examples.append({
                'issue': kind, 'field': field, 'record_id': id_, 'sha256': sha,
                'collection': collection, 'primary': compact(primary_value),
                'manifest': compact(manifest_value), 'note': note,
            })
            example_counts[(kind, token)] += 1

    total_sources = total_details = 0
    for shard in range((count + chunk - 1) // chunk):
        suffix = f'{shard:04d}.json.gz'
        records = read_json(data / 'records' / suffix, gz=True)
        details = read_json(data / 'details' / suffix, gz=True)
        expected = min(chunk, count - shard * chunk)
        if not isinstance(records, list) or not isinstance(details, list) or len(records) != expected or len(details) != expected:
            raise ValueError(f'Record/detail shard alignment mismatch: {suffix}')
        for offset, (record, pair_rows) in enumerate(zip(records, details)):
            id_ = shard * chunk + offset
            if not isinstance(record, list) or len(record) != 5 or not isinstance(pair_rows, list):
                raise ValueError(f'Invalid record or details at ID {id_}')
            sha, _, _, sources, quick = record
            if (not isinstance(sha, str) or not isinstance(sources, list) or
                not isinstance(quick, list) or len(quick) != len(FIELDS)):
                raise ValueError(f'Invalid source or primary metadata at ID {id_}')
            total_sources += len(sources)
            source_collections = set()
            crcs = set()
            for source in sources:
                if not isinstance(source, list) or len(source) != 4 or source[0] not in (0, 1):
                    raise ValueError(f'Invalid archive source at ID {id_}')
                source_collections.add(source[0])
                if nonblank(source[3]):
                    crcs.add(nonblank(source[3]).casefold())
            if len(crcs) > 1:
                observe('source_crc_disagreement', '', id_, sha,
                        manifest_value=', '.join(sorted(crcs)),
                        note='Different recorded CRC32s for the same SHA-256')

            primary_values = {}
            for field, value in zip(FIELDS, quick):
                if not isinstance(value, (str, type(None))):
                    raise ValueError(f'Invalid primary {field} at ID {id_}')
                primary_values[field] = nonblank(value)
                primary[field]['present' if nonblank(value) else 'missing'] += 1
                if comparable(value) in ('?', 'n/a', 'unknown', 'null', 'none'):
                    primary[field]['placeholder_like'] += 1

            parsed = {}
            for detail in pair_rows:
                if not isinstance(detail, list) or len(detail) != 4 or detail[0] not in (0, 1) or not isinstance(detail[1], dict):
                    raise ValueError(f'Invalid metadata detail at ID {id_}')
                coll, raw = detail[:2]
                total_details += 1
                if coll in parsed:
                    observe('duplicate_collection_detail', '', id_, sha, COLLECTIONS[coll])
                    continue
                canonical = canonical_manifest(raw)
                parsed[coll] = canonical
                by_collection[COLLECTIONS[coll]]['detail_pairs'] += 1

                for name, value in raw.items():
                    key = str(name).strip().casefold()
                    if not key:
                        continue
                    if key not in inventory:
                        inventory[key] = [0, 0, str(name), '']
                    # Count one detail per canonical key (rather than case variants).
                for key, values in canonical.items():
                    row = inventory[key]
                    row[0] += 1
                    value = next((item for item in values if item), '')
                    if value:
                        row[1] += 1
                        if not row[3]:
                            row[3] = compact(value)
                    nonempty = {comparable(value) for value in values if value}
                    if len(nonempty) > 1:
                        observe('intra_manifest_conflict', key, id_, sha, COLLECTIONS[coll],
                                manifest_value=' | '.join(sorted(nonempty)),
                                note='Different values under case-variant keys')

                for field, key in MANIFEST_KEYS.items():
                    values = canonical.get(key, [])
                    extracted = next((value for value in values if value), '')
                    by_collection[COLLECTIONS[coll]]['manifest_fields'][field][
                        'present' if extracted else 'missing'] += 1

            for coll in source_collections - parsed.keys():
                observe('missing_collection_detail', '', id_, sha, COLLECTIONS[coll])

            # The builder prefers Full metadata whenever Full is a source.
            preferred = 1 if 1 in source_collections else 0
            preferred_values = parsed.get(preferred, {})
            other_values = parsed.get(1 - preferred, {})
            for field, key in MANIFEST_KEYS.items():
                preferred_raw = next((v for v in preferred_values.get(key, []) if v), '')
                other_raw = next((v for v in other_values.get(key, []) if v), '')
                actual = primary_values[field]
                if not actual:
                    if preferred_raw:
                        observe('primary_missing_manifest_present', field, id_, sha,
                                COLLECTIONS[preferred], manifest_value=preferred_raw,
                                note='Selected primary field is blank')
                    elif other_raw:
                        observe('primary_missing_other_manifest_present', field, id_, sha,
                                COLLECTIONS[1 - preferred], manifest_value=other_raw,
                                note='Only the non-preferred collection has this field')
                elif preferred_raw and comparable(actual) != comparable(preferred_raw):
                    # Some MIDlet names come from MIDlet-1 rather than MIDlet-Name.
                    observe('primary_manifest_difference', field, id_, sha,
                            COLLECTIONS[preferred], actual, preferred_raw,
                            note='Informational; primary field can have a different origin')
                if preferred_raw and other_raw and comparable(preferred_raw) != comparable(other_raw):
                    observe('cross_collection_difference', field, id_, sha,
                            collection='Full vs Lite' if preferred == 1 else 'Lite vs Full',
                            primary_value=preferred_raw, manifest_value=other_raw,
                            note='Same SHA-256, differing collection manifest values')
        if (shard + 1) % 20 == 0 or shard + 1 == (count + chunk - 1) // chunk:
            print(f'Audited {min((shard + 1) * chunk, count):,}/{count:,} unique records...', flush=True)

    if total_sources != manifest.get('total_rows'):
        raise ValueError(f'Source count {total_sources} disagrees with manifest total_rows')
    possible = [key for key in inventory if any(term in key for term in EXTENSION_TERMS)]
    report = {
        'schema_version': 1,
        'basis': 'published schema-4 records and collection manifest details; no JAR bytes inspected',
        'units': {
            'primary_fields': 'unique SHA-256 records (chosen Full metadata if available, else Lite)',
            'manifest_fields': 'distinct (SHA-256, collection) detail pairs',
            'cross_collection': 'unique SHA-256 records with two comparable nonempty values',
            'examples': 'bounded observations, not a complete inventory of affected records',
        },
        'unique_files': count, 'archive_member_sources': total_sources,
        'collection_detail_pairs': total_details,
        'primary_fields': {key: dict(value) for key, value in primary.items()},
        'collections': {name: {'detail_pairs': value['detail_pairs'],
            'manifest_fields': {field: dict(counter) for field, counter in value['manifest_fields'].items()}}
            for name, value in by_collection.items()},
        'observations': {kind: dict(counts) for kind, counts in observations.items()},
        'manifest_key_types': len(inventory),
        'possible_extension_key_types': len(possible),
        'example_limit_per_issue_and_field': max_examples,
        'example_limit_total': max_total_examples,
        'limitations': [
            'This is a metadata availability audit, not a proof that reported values are correct.',
            'A blank primary version is what @version=? tests within an existing text result set.',
            'Manifest-derived name/version/profile values may not be the chosen primary fields.',
            'Candidate display/language/device keys are not validated device compatibility or screen-resolution measurements.',
        ],
    }
    return report, inventory, examples


def csv_cell(value):
    """Keep untrusted manifest strings inert in common spreadsheet viewers."""
    if isinstance(value, str) and re.match(r'^[\s\x00-\x1f]*[=+\-@]', value):
        return "'" + value
    return value


def write_reports(directory, report, inventory, examples):
    (directory / 'summary.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    with (directory / 'manifest-fields.csv').open('w', encoding='utf-8', newline='') as stream:
        out = csv.writer(stream)
        out.writerow(['canonical_key', 'detail_pairs_with_key', 'detail_pairs_with_value', 'example_spelling', 'example_value'])
        for key, row in sorted(inventory.items(), key=lambda p: (-p[1][1], p[0])):
            out.writerow([csv_cell(value) for value in [key, *row]])
    with (directory / 'possible-extension-fields.csv').open('w', encoding='utf-8', newline='') as stream:
        out = csv.writer(stream)
        out.writerow(['canonical_key', 'detail_pairs_with_key', 'detail_pairs_with_value', 'example_spelling', 'example_value'])
        for key, row in sorted(inventory.items(), key=lambda p: (-p[1][1], p[0])):
            if any(term in key for term in EXTENSION_TERMS):
                out.writerow([csv_cell(value) for value in [key, *row]])
    with (directory / 'examples.csv').open('w', encoding='utf-8', newline='') as stream:
        out = csv.DictWriter(stream, fieldnames=SAMPLE_COLUMNS)
        out.writeheader()
        out.writerows({name: csv_cell(value) for name, value in example.items()}
                      for example in examples)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--data', type=Path, required=True,
                        help='Existing published or rebuilt schema-4 data/ directory')
    parser.add_argument('--out', type=Path, required=True,
                        help='NEW report directory; never replaces an existing path')
    parser.add_argument('--max-examples', type=int, default=12,
                        help='Examples per issue and field, default 12; 0 disables examples')
    parser.add_argument('--max-total-examples', type=int, default=500,
                        help='Overall example row cap, default 500')
    args = parser.parse_args(argv)
    try:
        source = args.data.expanduser().resolve(strict=True)
        out = args.out.expanduser().absolute()
        if not source.is_dir():
            raise ValueError(f'Not a directory: {source}')
        if out.exists() or out.is_symlink():
            raise ValueError(f'Refusing to overwrite existing path: {out}')
        if not out.parent.is_dir():
            raise ValueError(f'Output parent does not exist: {out.parent}')
        if out == source or source in out.resolve().parents:
            raise ValueError('Refusing to write reports inside the source index')
        report, inventory, examples = audit(source, max_examples=args.max_examples,
                                           max_total_examples=args.max_total_examples)
        with tempfile.TemporaryDirectory(prefix='.j2me-metadata-', dir=out.parent) as temp:
            stage = Path(temp)
            write_reports(stage, report, inventory, examples)
            if out.exists() or out.is_symlink():
                raise ValueError(f'Output appeared during audit: {out}')
            os.rename(stage, out)
        print(f'Primary version missing: {report["primary_fields"]["version"].get("missing", 0):,}'
              f' / {report["unique_files"]:,} unique records')
        print(f'Manifest keys inventoried: {report["manifest_key_types"]:,}; '
              f'possible extension keys: {report["possible_extension_key_types"]:,}')
        print(f'Quality report ready: {out} (source index unchanged)')
        return 0
    except (OSError, ValueError, EOFError, UnicodeError, json.JSONDecodeError) as exc:
        print(f'Metadata audit FAILED: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
