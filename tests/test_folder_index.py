"""Tiny end-to-end fixtures for folder-index generation and compatibility."""

import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
sys.path.insert(0, str(TOOLS))
from build_folder_groups import build  # noqa: E402
from check_folder_index import check_folder_index, FolderIndexError  # noqa: E402


def write_json(path, payload, *, compressed=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    path.write_bytes(gzip.compress(encoded) if compressed else encoded + b'\n')


class FolderCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.data = self.repo / 'data'
        write_json(self.data / 'manifest.json', {
            'schema_version': 4, 'unique_files': 3, 'record_chunk': 2,
            'schema': ['sha256', 'sha1', 'size', 'sources', 'primary_midlet_metadata'],
            'source_schema': ['collection_code', 'filename', 'archive_path', 'crc32']
        })
        self.rows = [
            ['a' * 64, '1' * 40, 120,
             [[0, 'Sonic.jar', 'Games/Sonic.jar', '00112233']],
             ['Sonic 👾', 'Vendor', '1.0', '', '']],
            ['b' * 64, '2' * 40, 121,
             [[1, 'Echo.jar', 'Games/Echo.jar', '11223344']],
             ['Echo', 'Vendor', '2.0', '', '']],
            ['c' * 64, '3' * 40, 122,
             [[0, 'Solo.jar', 'Utilities/Solo.jar', '22334455']],
             ['', '', '', '', '']]
        ]
        self.write_records()

    def write_records(self):
        write_json(self.data / 'records/0000.json.gz', self.rows[:2], compressed=True)
        write_json(self.data / 'records/0001.json.gz', self.rows[2:], compressed=True)

    def test_valid_records_are_bound_to_folder_manifest(self):
        build(self.repo)
        stats = json.loads((self.data / 'folders/manifest.json').read_bytes())
        self.assertEqual(stats['schema_version'], 2)
        self.assertRegex(stats['records_sha256'], r'^[0-9a-f]{64}$')
        self.assertEqual(stats['folders_with_multiple_contents'], 1)
        self.assertIn('3 records', check_folder_index(self.repo))

    def test_recompressing_identical_records_preserves_compatibility(self):
        build(self.repo)
        path = self.data / 'records/0000.json.gz'
        with gzip.open(path, 'rb') as stream:
            raw = stream.read()
        path.write_bytes(gzip.compress(raw, mtime=123456))
        self.assertIn('passed', check_folder_index(self.repo))

    def test_reordered_record_ids_fail_even_if_main_manifest_is_unchanged(self):
        build(self.repo)
        main_before = (self.data / 'manifest.json').read_bytes()
        self.rows[0], self.rows[1] = self.rows[1], self.rows[0]
        self.write_records()
        self.assertEqual((self.data / 'manifest.json').read_bytes(), main_before)
        with self.assertRaisesRegex(FolderIndexError, 'record contents/ID assignments'):
            check_folder_index(self.repo)

    def test_changed_source_path_fails_even_if_hash_id_is_unchanged(self):
        build(self.repo)
        self.rows[0][3][0][2] = 'Elsewhere/Sonic.jar'
        self.write_records()
        with self.assertRaisesRegex(FolderIndexError, 'record contents/ID assignments'):
            check_folder_index(self.repo)

    def test_regeneration_restores_compatibility(self):
        build(self.repo)
        self.rows[0], self.rows[1] = self.rows[1], self.rows[0]
        self.write_records()
        with self.assertRaises(FolderIndexError):
            check_folder_index(self.repo)
        build(self.repo)
        self.assertIn('passed', check_folder_index(self.repo))

    def test_legacy_folder_index_requires_rebuild(self):
        build(self.repo)
        path = self.data / 'folders/manifest.json'
        legacy = json.loads(path.read_bytes())
        legacy['schema_version'] = 1
        legacy.pop('records_sha256')
        write_json(path, legacy)
        with self.assertRaisesRegex(FolderIndexError, 'Obsolete folder index'):
            check_folder_index(self.repo)

    def test_optional_absence_and_required_mode(self):
        self.assertIn('skipped', check_folder_index(self.repo))
        with self.assertRaisesRegex(FolderIndexError, 'Folder index absent'):
            check_folder_index(self.repo, require_folders=True)


if __name__ == '__main__':
    unittest.main()
