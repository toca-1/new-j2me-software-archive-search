#!/usr/bin/env python3
"""Single entry point for a SAFE, reference-backed JARchive site-index rebuild.

From a repository containing its published data/ and the four JARchive .7z
archives, one invocation reconstructs enrichment, builds the current core
index, builds folder/search-summary supplements, validates them, compares every
core file with SHA-256, and publishes a *new* candidate directory.

This orchestrates the other tested tools in tools/; it is NOT an independent
rehash of 816,215 JAR bytes, nor a generator for separate upstream archives.
See docs/REBUILD_ALL.md for exact prerequisites and limitations.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if __package__:
    from . import compare_core_hashes
else:
    import compare_core_hashes

TOOLS = Path(__file__).resolve().parent
ARCHIVE_NAMES = (
    'JARchiveLite_v11.7z', 'JARchive_v11.7z',
    'JARchiveLite_v11_infofiles.7z', 'JARchive_v11_infofiles.7z',
)
ENRICHMENT_NAMES = ('jarchive-enriched.csv', 'jarchive-enriched-details.jsonl.gz')
CORE_EQUALS_REQUIRED = ('records', 'details', 'crc32', 'sha1', 'sha256', 'names-v2', 'manifest.json')


class RebuildError(ValueError):
    """Unsafe input/output or mismatch with the published reference."""


def run_tool(name: str, *args: object) -> None:
    cmd = [sys.executable, str(TOOLS / name), *(str(value) for value in args)]
    print(f'\n>>> {name} ' + ' '.join(str(value) for value in args), flush=True)
    subprocess.run(cmd, check=True)


def ensure_new_output(out: Path, reference: Path, inputs: list[Path]) -> None:
    if out.exists() or out.is_symlink():
        raise RebuildError(f'Output already exists; refusing to overwrite: {out}')
    if not out.parent.is_dir():
        raise RebuildError(f'Output parent does not exist: {out.parent}')
    for protected in [reference, *inputs, TOOLS.parent]:
        # The generated output must never live inside any original input or
        # inside the source repository (accidental git add of large datasets).
        if out == protected or protected in out.parents:
            raise RebuildError(f'Output {out} must not be inside source directory {protected}')


def copy_read_only(source: Path, target: Path) -> None:
    if source.is_symlink():
        raise RebuildError(f'Refusing to copy a symlink: {source}')
    if source.is_dir():
        for item in source.rglob('*'):
            if item.is_symlink():
                raise RebuildError(f'Refusing to copy a symlink: {item}')
            if not item.is_dir() and not item.is_file():
                raise RebuildError(f'Unexpected source entry: {item}')
        shutil.copytree(source, target)
    elif source.is_file():
        shutil.copy2(source, target)
    else:
        raise RebuildError(f'Missing input: {source}')


def evaluate_comparison(existing: Path, rebuilt: Path) -> dict:
    report = compare_core_hashes.compare(existing, rebuilt, progress=True)
    compare_core_hashes.print_report(report)
    counts = report['counts']
    if report['missing'] or report['extra']:
        raise RebuildError('Core index contains missing or unexpected paths')
    if any(report['by_group'].get(group, Counter()).get('content_differs', 0)
           for group in CORE_EQUALS_REQUIRED):
        raise RebuildError('At least one core data file differs from the reference')
    if report['by_group'].get('build-summary.json', Counter()).get('content_differs', 0) > 1:
        raise RebuildError('Unexpected extra summary differences')

    left = json.loads((existing / 'manifest.json').read_text(encoding='utf-8'))
    right = json.loads((rebuilt / 'manifest.json').read_text(encoding='utf-8'))
    if left != right:
        raise RebuildError('Manifest values differ from the reference')
    # Every individual names-v2 shard has already been compared byte-for-byte,
    # as uncompressed bytes, or as ordered JSON arrays. A matching inventory
    # plus equal manifest guarantees identical entry order and shard boundaries;
    # scanning all two million names a second time adds no assurance.
    print('Name entries and shard boundaries match (per-shard content verified)',
          flush=True)
    if counts['content_differs'] > 1:
        raise RebuildError('Only build-summary.json may have different values')
    # Return stable JSON-serializable counts and per-group breakdown, no
    # project-specific absolute paths and no tuple-key example dictionary.
    return {'files_compared': report['total'], 'counts': dict(counts),
            'by_group': {key: dict(value) for key, value in report['by_group'].items()},
            'missing': 0, 'extra': 0,
            'names': left['search_terms'],
            'name_shards': left['names_chunks'],
            'same_name_sequence': True, 'same_name_boundaries': True,
            'note': 'Different gzip headers/DEFLATE streams and the historically stale '
                    'build-summary.json are permitted; core data values must match.'}


def rebuild(*, reference: Path, out: Path, archive_dir: Path | None = None,
            enriched_dir: Path | None = None, temp_dir: Path | None = None,
            expected_rows: int = 816215, expected_unique: int = 620287,
            record_chunk: int = 4096, name_shards: int = 1024,
            max_original_paths: int = 2, strict_info: bool = False,
            copy_reference_extras: bool = True,
            archive_paths: dict[str, Path] | None = None) -> dict:
    reference = reference.expanduser().resolve(strict=True)
    out = out.expanduser().resolve(strict=False)
    if not reference.is_dir() or not (reference / 'manifest.json').is_file():
        raise RebuildError(f'Expected a full published data/ directory: {reference}')
    if temp_dir is not None:
        temp_dir = temp_dir.expanduser().resolve(strict=True)
        if not temp_dir.is_dir():
            raise RebuildError(f'Temporary directory is not a directory: {temp_dir}')
    if expected_rows < 1 or expected_unique < 1 or record_chunk < 1 or name_shards < 1:
        raise RebuildError('Expected counts, record chunk, and name shards must be positive')
    if max_original_paths != 2:
        # A different value changes the recorded details and would invalidate
        # the strict published-reference equivalence requirement.
        raise RebuildError('Reference-equivalent reconstruction requires --max-original-paths 2')

    sources = []
    if enriched_dir is not None:
        if strict_info:
            raise RebuildError('--strict-info is only applicable to new archive reconstruction')
        if archive_dir is not None or archive_paths:
            raise RebuildError('Choose either --enriched-dir or the archive inputs, not both')
        enriched_dir = enriched_dir.expanduser().resolve(strict=True)
        sources = [enriched_dir]
        for filename in ENRICHMENT_NAMES:
            if not (enriched_dir / filename).is_file():
                raise RebuildError(f'Missing enrichment input: {enriched_dir / filename}')
        mode = 'saved-enrichment'
    else:
        archive_paths = archive_paths or {}
        if archive_dir is None and not all(name in archive_paths for name in ARCHIVE_NAMES):
            raise RebuildError('Specify --archive-dir, --enriched-dir, or all four archive inputs')
        if archive_dir is not None:
            archive_dir = archive_dir.expanduser().resolve(strict=True)
            sources = [archive_dir]
        else:
            sources = list(archive_paths.values())
        for filename in ARCHIVE_NAMES:
            path = archive_paths.get(filename)
            if path is None:
                path = archive_dir / filename
            path = path.expanduser().resolve(strict=True)
            if not path.is_file():
                raise RebuildError(f'Missing archive: {path}')
            archive_paths[filename] = path
        mode = 'archive-reference-reconstruction'
    ensure_new_output(out, reference, sources)
    if out in (reference, enriched_dir):
        raise RebuildError('Cannot write into the reference or an input directory')

    # Validating the reference is essential: this pipeline inherits published
    # SHA-1/SHA-256 and metadata; it does not compute those from JAR bytes.
    print('Stage 1/8: Exhaustively validate the published reference', flush=True)
    check_args = ['--data', reference]
    if temp_dir is not None:
        check_args += ['--temp-dir', temp_dir]
    run_tool('check_full_index.py', *check_args)

    with tempfile.TemporaryDirectory(prefix='.j2me-all-staging-', dir=out.parent) as staged:
        root = Path(staged)
        enriched = root / 'enrichment'
        data = root / 'data'
        print('\nStage 2/8: Prepare enriched CSV and manifest details', flush=True)
        if enriched_dir is not None:
            enriched.mkdir()
            for name in ENRICHMENT_NAMES:
                copy_read_only(enriched_dir / name, enriched / name)
            original_audit = enriched_dir / 'reconstruction-audit.json'
            if original_audit.is_file():
                copy_read_only(original_audit, enriched / original_audit.name)
                source_audit = json.loads((enriched / original_audit.name).read_text())
            else:
                source_audit = {'method': 'Existing enriched inputs copied verbatim; '
                                          'no reconstruction audit provided or JAR bytes rehashed'}
        else:
            args = ['--data', reference, '--lite-archive', archive_paths[ARCHIVE_NAMES[0]],
                    '--full-archive', archive_paths[ARCHIVE_NAMES[1]],
                    '--lite-info', archive_paths[ARCHIVE_NAMES[2]],
                    '--full-info', archive_paths[ARCHIVE_NAMES[3]],
                    '--out', enriched, '--expected-rows', expected_rows,
                    '--expected-unique', expected_unique]
            if strict_info:
                args.append('--strict-info')
            if temp_dir is not None:
                args += ['--temp-dir', temp_dir]
            run_tool('reconstruct_enrichment.py', *args)
            source_audit = json.loads((enriched / 'reconstruction-audit.json').read_text())

        print('\nStage 3/8: Build and fully validate the core index', flush=True)
        args = ['--input', enriched / ENRICHMENT_NAMES[0],
                '--details', enriched / ENRICHMENT_NAMES[1], '--out', data,
                '--expected-count', expected_rows, '--expected-unique', expected_unique,
                '--record-chunk', record_chunk, '--name-shards', name_shards,
                '--name-layout', 'published', '--max-original-paths', max_original_paths]
        if temp_dir is not None:
            args += ['--temp-dir', temp_dir]
        run_tool('build_site.py', *args)

        print('\nStage 4/8: Generate folder browsing and fast search summaries', flush=True)
        run_tool('build_folder_groups.py', '--repo', root)
        run_tool('build_search_summaries.py', '--repo', root)

        print('\nStage 5/8: Validate folder index and core index again', flush=True)
        run_tool('check_folder_index.py', '--repo', root, '--require-folders')
        args = ['--data', data]
        if temp_dir is not None:
            args += ['--temp-dir', temp_dir]
        run_tool('check_full_index.py', *args)

        print('\nStage 6/8: SHA-256 and per-shard name comparison', flush=True)
        comparison = evaluate_comparison(reference, data)

        print('\nStage 7/8: Retain optional published download indexes', flush=True)
        reused = {}
        if copy_reference_extras:
            # Only reuse SHA-keyed download mappings when the core records are
            # *byte-identical*: exact SHA-256 identity and record IDs verified.
            groups = comparison['by_group'].get('records', {})
            n_records = (json.loads((data / 'manifest.json').read_text())['unique_files']
                         + record_chunk - 1) // record_chunk
            if groups.get('exact', 0) != n_records:
                raise RebuildError('Cannot copy published download indexes: '
                                   'record shards are not byte-identical')
            upstream = reference / 'upstream'
            if upstream.exists() or upstream.is_symlink():
                copy_read_only(upstream, data / 'upstream')
                reused['data/upstream'] = 'Copied from reference; not reconstructed or URL-audited'
            else:
                reused['data/upstream'] = 'Not available in reference'
            # Downloader retrieval/v1 lives alongside data/, not inside it.
            retrieval = reference.parent / 'retrieval' / 'v1'
            if retrieval.is_dir():
                (root / 'retrieval').mkdir()
                copy_read_only(retrieval, root / 'retrieval' / 'v1')
                reused['retrieval/v1'] = 'Copied from reference; not reconstructed or URL-audited'
            else:
                reused['retrieval/v1'] = 'Not available alongside reference'
        else:
            reused = {'data/upstream': 'Skipped by user', 'retrieval/v1': 'Skipped by user'}

        print('\nStage 8/8: Write provenance report and publish new candidate', flush=True)
        manifest = json.loads((data / 'manifest.json').read_text())
        report = {
            'method': 'reference-backed (NOT independent JAR content hashing)',
            'input_mode': mode,
            'archive_rows': manifest['total_rows'], 'unique_jar_contents': manifest['unique_files'],
            'search_name_entries': manifest['search_terms'],
            'enrichment_audit': source_audit,
            'core_sha256_comparison': comparison,
            'supplemental_indexes': ['data/folders', 'data/search-summaries'],
            'reused_optional_assets': reused,
            'byte_identity': 'Not guaranteed; original name gzip headers contain '
                             'timestamps and filenames, and published build-summary is stale.',
            'output_not_deployed': True,
        }
        (root / 'rebuild-report.json').write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + '\n',
            encoding='utf-8')
        if out.exists() or out.is_symlink():
            raise RebuildError(f'Output appeared during build: {out}')
        os.rename(root, out)
    print(f'\nSUCCESS: Complete candidate is ready at {out}', flush=True)
    print('Published data and archives were not changed. See rebuild-report.json.', flush=True)
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--reference-data', type=Path, default=Path('data'),
                        help='Existing validated data/ (default: ./data)')
    parser.add_argument('--archive-dir', type=Path,
                        help='Directory containing all four original .7z archives')
    for flag, help_text in (
        ('--lite-archive', 'Override the Lite .7z path (or supply a 7z -slt listing text)'),
        ('--full-archive', 'Override the Full .7z path (or supply a 7z -slt listing text)'),
        ('--lite-info', 'Override the Lite infofiles .7z (or complete JSON)'),
        ('--full-info', 'Override the Full infofiles .7z (or complete JSON)'),
    ):
        parser.add_argument(flag, type=Path, help=help_text)
    parser.add_argument('--enriched-dir', type=Path,
                        help='Use already reconstructed CSV + JSONL.gz instead of archives')
    parser.add_argument('--out', required=True, type=Path,
                        help='NEW output root containing data/, enrichment/, and verification report')
    parser.add_argument('--temp-dir', type=Path,
                        help='Existing directory for temporary SQLite databases')
    parser.add_argument('--expected-rows', type=int, default=816215)
    parser.add_argument('--expected-unique', type=int, default=620287)
    parser.add_argument('--record-chunk', type=int, default=4096)
    parser.add_argument('--name-shards', type=int, default=1024)
    parser.add_argument('--max-original-paths', type=int, default=2)
    parser.add_argument('--strict-info', action='store_true',
                        help='Reject any manifest disagreement or infofile fallback')
    parser.add_argument('--no-copy-reference-extras', action='store_true',
                        help='Do not copy published data/upstream or retrieval/v1 assets')
    args = parser.parse_args(argv)
    override = {name: path for name, path in (
        (ARCHIVE_NAMES[0], args.lite_archive),
        (ARCHIVE_NAMES[1], args.full_archive),
        (ARCHIVE_NAMES[2], args.lite_info),
        (ARCHIVE_NAMES[3], args.full_info),
    ) if path is not None}
    try:
        rebuild(reference=args.reference_data, archive_dir=args.archive_dir,
                enriched_dir=args.enriched_dir, out=args.out, temp_dir=args.temp_dir,
                expected_rows=args.expected_rows, expected_unique=args.expected_unique,
                record_chunk=args.record_chunk, name_shards=args.name_shards,
                max_original_paths=args.max_original_paths, strict_info=args.strict_info,
                copy_reference_extras=not args.no_copy_reference_extras,
                archive_paths=override)
    except (RebuildError, OSError, ValueError, subprocess.CalledProcessError,
            json.JSONDecodeError, KeyError) as error:
        print(f'FULL REBUILD FAILED: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
