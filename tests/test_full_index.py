"""Corruption tests for the deliberately optional, exhaustive index validator."""
from __future__ import annotations

import gzip
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('check_full_index', ROOT / 'tools/check_full_index.py')
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


def write_json(path, payload, compressed=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    path.write_bytes(gzip.compress(encoded, mtime=0) if compressed else encoded)


def mutate_json(path, callback, *, compressed=True):
    data = checker.read_json(path, gz=compressed)
    callback(data)
    write_json(path, data, compressed=compressed)


class FullIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'data'
        self.records = [
            ['a' * 64, '1' * 40, 123,
             [[0, 'Sonic.jar', 'Games/Sonic.jar', 'DEADBEEF'],
              [1, 'Sonic HD.jar', 'Sonic/Sonic HD.jar', 'BAADFACE']],
             ['Sonic 💫', 'SEGA', '1.0', 'CLDC-1.1', 'MIDP-2.0']],
            ['b' * 64, '2' * 40, 456,
             [[0, 'Sonic 2.jar', 'Games/Sonic 2.jar', 'DEADBEEF']],
             ['Sonic 2', 'SEGA', '2.0', 'CLDC-1.1', 'MIDP-2.0']],
            ['c' * 64, '3' * 40, 789,
             [[1, 'Tetris.jar', 'Games/Tetris.jar', '00112233']],
             ['', 'EA', '', '', '']],
        ]
        self.details = [
            [[0, {'MIDlet-Name': 'Sonic 💫'}, ['Games/Sonic.jar'], 2]],
            [],
            [[1, {'MIDlet-Name': 'Tetris'}, [], 0]],
        ]
        self.setup_index()

    def setup_index(self):
        labels = []
        for record_id, record in enumerate(self.records):
            labels.extend([[label, record_id, kind] for kind, label in
                           sorted(checker.expected_search_labels(record[3], record[4]))])
        # Multiple shards, with an unused bucket, and a CRC collision.
        by_shard = {0: [], 1: [], 3: []}
        for index, row in enumerate(labels):
            by_shard[(0, 1, 3)[index % 3]].append(row)
        grams = {2: {}, 3: {}}
        for shard, rows in by_shard.items():
            write_json(self.data / 'names-v2' / f'{shard:03d}.json.gz', rows)
            checker.gram_bits([r[0] for r in rows], shard, grams)
        write_json(self.data / 'names-v2' / 'grams.json.gz', {
            str(n): {key: format(bits, 'x') for key, bits in values.items()}
            for n, values in grams.items()
        })
        for shard in range(2):
            write_json(self.data / 'records' / f'{shard:04d}.json.gz', self.records[shard*2:(shard+1)*2])
            write_json(self.data / 'details' / f'{shard:04d}.json.gz', self.details[shard*2:(shard+1)*2])
        hashes = {name: {key: {} for key in '0123456789abcdef'}
                  for name in ('crc32', 'sha1', 'sha256')}
        for record_id, record in enumerate(self.records):
            for kind, value in (('sha1', record[1]), ('sha256', record[0])):
                hashes[kind][value[0]][value] = record_id
            for crc in {source[3].lower() for source in record[3]}:
                hashes['crc32'][crc[0]].setdefault(crc, []).append(record_id)
        for kind in hashes:
            for bucket, rows in hashes[kind].items():
                write_json(self.data / kind / f'{bucket}.json.gz', rows)
        write_json(self.data / 'manifest.json', {
            'schema_version': 4,
            'schema': checker.SCHEMA, 'source_schema': checker.SOURCE_SCHEMA,
            'record_chunk': 2, 'unique_files': 3,
            'names_chunks': 4, 'names_grams': 'names-v2/grams.json.gz',
            'lite_only': 1, 'full_only': 1, 'shared_files': 1,
            'lite_rows': 2, 'full_rows': 2, 'total_rows': 4,
            'search_terms': len(labels)
        }, compressed=False)

    def check(self):
        return checker.check_full_index(self.data)

    def test_full_valid_index_passes(self):
        report = self.check()
        self.assertIn('3 records', report)
        self.assertIn('CRC32', report)

    def test_cli_succeeds_and_is_read_only(self):
        before = {str(p.relative_to(self.data)): p.read_bytes()
                  for p in self.data.rglob('*') if p.is_file()}
        result = subprocess.run([sys.executable, str(ROOT / 'tools/check_full_index.py'),
                                 '--data', str(self.data)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Full index validation passed', result.stdout)
        self.assertEqual(before, {str(p.relative_to(self.data)): p.read_bytes()
                                  for p in self.data.rglob('*') if p.is_file()})

    def test_missing_middle_shard_fails(self):
        (self.data / 'details/0000.json.gz').unlink()
        with self.assertRaisesRegex(checker.FullIndexError, 'details shard set'):
            self.check()

    def test_corrupt_unselected_record_fails(self):
        # A whole-index pass must read the final, shorter shard too.
        path = self.data / 'records/0001.json.gz'
        mutate_json(path, lambda data: data[0].__setitem__(0, 'not-a-hash'))
        with self.assertRaisesRegex(checker.FullIndexError, 'record ID 2: invalid SHA-256'):
            self.check()

    def test_invalid_source_crc_fails(self):
        path = self.data / 'records/0000.json.gz'
        mutate_json(path, lambda data: data[0][3][0].__setitem__(3, 'NOPE'))
        with self.assertRaisesRegex(checker.FullIndexError, 'invalid CRC32'):
            self.check()

    def test_duplicate_sha1_fails(self):
        path = self.data / 'records/0000.json.gz'
        mutate_json(path, lambda data: data[1].__setitem__(1, data[0][1]))
        with self.assertRaisesRegex(checker.FullIndexError, 'duplicate SHA checksum'):
            self.check()

    def test_manifest_counts_reconcile_with_sources(self):
        path = self.data / 'manifest.json'
        mutate_json(path, lambda data: data.__setitem__('lite_rows', 999), compressed=False)
        with self.assertRaisesRegex(checker.FullIndexError, 'lite_rows'):
            self.check()

    def test_malformed_detail_fails(self):
        path = self.data / 'details/0001.json.gz'
        mutate_json(path, lambda data: data[0][0].__setitem__(3, -1))
        with self.assertRaisesRegex(checker.FullIndexError, 'original path count'):
            self.check()

    def test_detail_from_wrong_archive_fails(self):
        path = self.data / 'details/0001.json.gz'
        mutate_json(path, lambda data: data[0][0].__setitem__(0, 0))
        with self.assertRaisesRegex(checker.FullIndexError, 'collection not present'):
            self.check()

    def test_sha_key_wrong_id_fails(self):
        path = self.data / 'sha256/a.json.gz'
        mutate_json(path, lambda data: data.__setitem__('a' * 64, 1))
        with self.assertRaisesRegex(checker.FullIndexError, 'different sha256'):
            self.check()

    def test_sha_omitted_fails(self):
        path = self.data / 'sha1/2.json.gz'
        mutate_json(path, lambda data: data.pop('2' * 40))
        with self.assertRaisesRegex(checker.FullIndexError, 'sha1 index covers 2 of 3'):
            self.check()

    def test_sha_wrong_bucket_fails(self):
        path = self.data / 'sha1/1.json.gz'
        mutate_json(path, lambda data: data.__setitem__('f' * 40, 0))
        with self.assertRaisesRegex(checker.FullIndexError, 'invalid sha1 key/bucket'):
            self.check()

    def test_missing_collision_id_fails(self):
        path = self.data / 'crc32/d.json.gz'
        mutate_json(path, lambda data: data.__setitem__('deadbeef', [0]))
        with self.assertRaisesRegex(checker.FullIndexError, 'CRC32 lookup missing'):
            self.check()

    def test_duplicate_collision_id_fails(self):
        path = self.data / 'crc32/d.json.gz'
        mutate_json(path, lambda data: data.__setitem__('deadbeef', [0, 0, 1]))
        with self.assertRaisesRegex(checker.FullIndexError, 'unexpected or duplicate record ID'):
            self.check()

    def test_missing_name_fails(self):
        path = self.data / 'names-v2/000.json.gz'
        mutate_json(path, lambda data: data.pop())
        with self.assertRaisesRegex(checker.FullIndexError, 'Name index missing label|Gram bitmap mismatch'):
            self.check()

    def test_name_wrong_source_id_fails(self):
        path = self.data / 'names-v2/001.json.gz'
        mutate_json(path, lambda data: data[0].__setitem__(1, 2))
        with self.assertRaisesRegex(checker.FullIndexError, 'unexpected/duplicate name'):
            self.check()

    def test_name_out_of_range_id_fails(self):
        path = self.data / 'names-v2/003.json.gz'
        mutate_json(path, lambda data: data[0].__setitem__(1, 900))
        with self.assertRaisesRegex(checker.FullIndexError, 'invalid record ID'):
            self.check()

    def test_name_unexpected_label_fails(self):
        path = self.data / 'names-v2/003.json.gz'
        mutate_json(path, lambda data: data[0].__setitem__(0, 'unrelated'))
        with self.assertRaisesRegex(checker.FullIndexError, 'unexpected/duplicate name'):
            self.check()

    def test_missing_gram_fails(self):
        path = self.data / 'names-v2/grams.json.gz'
        mutate_json(path, lambda data: data['2'].pop(next(iter(data['2']))))
        with self.assertRaisesRegex(checker.FullIndexError, 'missing 1 entries'):
            self.check()

    def test_incorrect_gram_bitmap_fails(self):
        path = self.data / 'names-v2/grams.json.gz'
        mutate_json(path, lambda data: data['3'].__setitem__(next(iter(data['3'])), 'f'))
        with self.assertRaisesRegex(checker.FullIndexError, 'Gram bitmap mismatch'):
            self.check()

    def test_missing_gram_shard_fails(self):
        (self.data / 'names-v2/001.json.gz').unlink()
        with self.assertRaisesRegex(checker.FullIndexError, 'Name index missing label|Gram bitmap mismatch'):
            self.check()

    def test_malformed_gzip_fails(self):
        (self.data / 'sha256/c.json.gz').write_bytes(b'wrong gzip')
        with self.assertRaisesRegex(checker.FullIndexError, 'Cannot read'):
            self.check()


if __name__ == '__main__':
    unittest.main()
