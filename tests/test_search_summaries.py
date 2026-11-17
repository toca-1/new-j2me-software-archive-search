"""Check the supplemental search-summary builder against a tiny synthetic index."""
from __future__ import annotations

import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_search_summaries', ROOT / 'tools/build_search_summaries.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class SearchSummaryBuilderTests(unittest.TestCase):
    def test_build_preserves_records_and_uses_name_shard_membership(self):
        with tempfile.TemporaryDirectory() as root:
            repo = Path(root)
            data = repo / 'data'
            (data / 'records').mkdir(parents=True)
            (data / 'names-v2').mkdir()
            manifest = dict(schema_version=4, unique_files=3, record_chunk=2,
                            names_chunks=2, names_grams='names-v2/grams.json.gz',
                            schema=['sha256', 'sha1', 'size', 'sources', 'primary_midlet_metadata'])
            manifest_bytes = json.dumps(manifest).encode('utf-8')
            (data / 'manifest.json').write_bytes(manifest_bytes)
            records = [
                ['sha0', 'sha1', 10, [[0, 'Prince.jar', 'archive/Prince.jar', 'crc']], ['', 'Studio A']],
                ['sha1', 'sha1', 20, [[0, 'Persia.jar', 'archive/Persia.jar', 'crc']], ['Persia', 'Studio B']],
                ['sha2', 'sha1', 30, [[0, 'Prince 2.jar', 'archive/Prince 2.jar', 'crc']], ['Prince II', 'Studio C']]
            ]
            def write(path, rows):
                with gzip.open(path, 'wt', encoding='utf-8') as stream:
                    json.dump(rows, stream)
            write(data / 'records' / '0000.json.gz', records[:2])
            write(data / 'records' / '0001.json.gz', records[2:])
            write(data / 'names-v2' / '000.json.gz', [['prince', 0, 0], ['persia', 1, 0]])
            write(data / 'names-v2' / '001.json.gz', [['prince ii', 2, 1], ['studio a', 0, 2]])
            before = [p.read_bytes() for p in sorted((data / 'records').glob('*.gz'))]
            builder.build(repo)
            with gzip.open(data / 'search-summaries' / '000.json.gz', 'rt', encoding='utf-8') as stream:
                first = json.load(stream)
            with gzip.open(data / 'search-summaries' / '001.json.gz', 'rt', encoding='utf-8') as stream:
                second = json.load(stream)
            self.assertEqual(first, [[0, 10, ['', 'Studio A'], ['Prince.jar']],
                                     [1, 20, ['Persia', 'Studio B'], ['Persia.jar']]])
            self.assertEqual(second, [[0, 10, ['', 'Studio A'], ['Prince.jar']],
                                      [2, 30, ['Prince II', 'Studio C'], ['Prince 2.jar']]])
            self.assertEqual(before, [p.read_bytes() for p in sorted((data / 'records').glob('*.gz'))])
            info = json.loads((data / 'search-summaries' / 'manifest.json').read_text())
            self.assertEqual(info['indexed_unique_files'], 3)
            self.assertEqual(info['summary_entries'], 4)
            # A full archive path must never be included in compact summary output.
            self.assertNotIn('archive/', str(first) + str(second))


if __name__ == '__main__':
    unittest.main()
