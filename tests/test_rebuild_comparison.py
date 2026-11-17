"""Protect reference-equivalence checks without a redundant full name-stream scan."""
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from rebuild_all import evaluate_comparison, RebuildError  # noqa: E402


class RebuildComparisonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.existing = Path(self.tmp.name) / 'existing'
        self.rebuilt = Path(self.tmp.name) / 'rebuilt'
        self.names = [[['alpha', 0, 0], ['bravo', 1, 1]], [['charlie', 2, 0]]]
        for root, mtime in ((self.existing, 0), (self.rebuilt, 1)):
            for group in ('records', 'details', 'crc32', 'sha1', 'sha256', 'names-v2'):
                (root / group).mkdir(parents=True)
                (root / group / '000.json.gz').write_bytes(gzip.compress(b'[]', mtime=mtime))
            for i, rows in enumerate(self.names):
                (root / 'names-v2' / f'{i:03}.json.gz').write_bytes(
                    gzip.compress(json.dumps(rows).encode(), mtime=mtime))
            (root / 'names-v2' / 'grams.json.gz').write_bytes(
                gzip.compress(b'{"2":{},"3":{}}', mtime=mtime))
            (root / 'manifest.json').write_text(json.dumps({
                'names_chunks': 2, 'search_terms': 3, 'unique_files': 3}))
            (root / 'build-summary.json').write_text(json.dumps({'files': 42 + mtime}))

    def replace_names(self, shards):
        for i, rows in enumerate(shards):
            (self.rebuilt / 'names-v2' / f'{i:03}.json.gz').write_bytes(
                gzip.compress(json.dumps(rows).encode(), mtime=1))

    def test_equivalent_per_shard_json_preserves_name_order_and_boundaries(self):
        report = evaluate_comparison(self.existing, self.rebuilt)
        self.assertEqual(report['names'], 3)
        self.assertTrue(report['same_name_sequence'])
        self.assertTrue(report['same_name_boundaries'])
        self.assertEqual(report['counts']['content_differs'], 1)  # historical summary

    def test_reordered_names_are_rejected(self):
        self.replace_names([[self.names[0][1], self.names[0][0]], self.names[1]])
        with self.assertRaisesRegex(RebuildError, 'core data file differs'):
            evaluate_comparison(self.existing, self.rebuilt)

    def test_changed_shard_boundary_is_rejected(self):
        self.replace_names([[self.names[0][0]], [self.names[0][1], self.names[1][0]]])
        with self.assertRaisesRegex(RebuildError, 'core data file differs'):
            evaluate_comparison(self.existing, self.rebuilt)

    def test_missing_name_shard_is_rejected(self):
        (self.rebuilt / 'names-v2' / '001.json.gz').unlink()
        with self.assertRaisesRegex(RebuildError, 'missing or unexpected'):
            evaluate_comparison(self.existing, self.rebuilt)


if __name__ == '__main__':
    unittest.main()
