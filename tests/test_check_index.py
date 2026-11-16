"""Self-contained smoke-check tests using tiny synthetic generated shards."""

import gzip
import json
import tempfile
import unittest
from pathlib import Path

from check_index import IndexCheckError, check_index


def write_json(path, payload, compressed=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload).encode('utf-8')
    path.write_bytes(gzip.compress(encoded) if compressed else encoded)


class IndexSmokeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'data'
        write_json(self.data / 'manifest.json', {
            'schema_version': 4, 'unique_files': 3, 'record_chunk': 2,
            'names_chunks': 4, 'names_grams': 'names-v2/grams.json.gz'
        }, compressed=False)
        # The last chunk is shorter; name buckets 1 and 2 are valid and empty.
        record = ['a' * 64, 'b' * 40, 100, [[0, 'a.jar', 'Games/a.jar', 'ABCD1234']],
                  ['Example', 'Vendor', '1.0', 'CLDC-1.1', 'MIDP-2.0']]
        write_json(self.data / 'records/0000.json.gz', [record, record])
        write_json(self.data / 'records/0001.json.gz', [record])
        write_json(self.data / 'details/0000.json.gz', [[], []])
        write_json(self.data / 'details/0001.json.gz', [[]])
        write_json(self.data / 'names-v2/grams.json.gz', {
            '2': {'so': '1', 'ni': '8'}, '3': {'son': '1', 'oni': '8'}
        })
        write_json(self.data / 'names-v2/000.json.gz', [['sonic.jar', 0, 0]])
        write_json(self.data / 'names-v2/003.json.gz', [['sonic', 2, 1]])
        for kind in ('crc32', 'sha1', 'sha256'):
            for digit in '0123456789abcdef':
                write_json(self.data / kind / f'{digit}.json.gz', {})

    def test_complete_index_passes(self):
        report = check_index(self.data)
        self.assertIn('2 record shards', report)
        self.assertIn('2 name shards', report)

    def test_missing_record_shard_fails(self):
        (self.data / 'records/0001.json.gz').unlink()
        with self.assertRaisesRegex(IndexCheckError, '0001.json.gz'):
            check_index(self.data)

    def test_missing_details_shard_fails(self):
        (self.data / 'details/0001.json.gz').unlink()
        with self.assertRaisesRegex(IndexCheckError, 'details'):
            check_index(self.data)

    def test_missing_name_shard_referenced_by_gram_map_fails(self):
        (self.data / 'names-v2/003.json.gz').unlink()
        with self.assertRaisesRegex(IndexCheckError, 'referenced name shards missing'):
            check_index(self.data)

    def test_missing_hash_bucket_fails(self):
        (self.data / 'crc32/a.json.gz').unlink()
        with self.assertRaisesRegex(IndexCheckError, 'crc32'):
            check_index(self.data)

    def test_corrupted_sampled_gzip_fails(self):
        (self.data / 'records/0000.json.gz').write_bytes(b'not gzip data')
        with self.assertRaisesRegex(IndexCheckError, 'Cannot read'):
            check_index(self.data)

    def test_truncated_sampled_record_chunk_fails(self):
        write_json(self.data / 'records/0000.json.gz', [['a']])
        with self.assertRaisesRegex(IndexCheckError, 'expected 2 rows'):
            check_index(self.data)

    def test_gram_map_cannot_reference_out_of_range_bucket(self):
        write_json(self.data / 'names-v2/grams.json.gz', {
            '2': {'so': '10'}, '3': {'son': '1'}
        })
        with self.assertRaisesRegex(IndexCheckError, 'invalid shard number'):
            check_index(self.data)


if __name__ == '__main__':
    unittest.main()
