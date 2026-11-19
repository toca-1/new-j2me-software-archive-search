"""Fast source-only regression tests for the archive-based rebuild."""
import csv
import os
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))

import rebuild_independent as rebuild
import index_mini as mini
import build_source_csv as combined
import assemble_site as assemble


class IndependentRebuildTests(unittest.TestCase):
    def test_v1_headers_are_resumable_without_duplicates(self):
        with sqlite3.connect(':memory:') as db:
            rebuild.v1_schema(db)
            headers = {'Game/Game.jar': (42, '1234ABCD')}
            rebuild.v1_headers(db, 'lite', 'JARchiveLite_v11.7z', headers, 1)
            rebuild.v1_headers(db, 'lite', 'JARchiveLite_v11.7z', headers, 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM members').fetchone()[0], 1)
            with self.assertRaisesRegex(RuntimeError, 'disagrees'):
                rebuild.v1_headers(db, 'lite', 'JARchiveLite_v11.7z',
                                   {'Game/Game.jar': (43, '1234ABCD')}, 1)

    def test_legacy_inventory_is_rejected_without_changes(self):
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE members (id INTEGER PRIMARY KEY, collection TEXT, member_path TEXT)')
            with self.assertRaisesRegex(RuntimeError, 'non-unique'):
                rebuild.v1_schema(db)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM members').fetchone()[0], 0)

    def test_unusual_mini_filename_preserves_raw_bytes(self):
        if os.name != 'posix':
            self.skipTest('Requires POSIX raw filesystem filename bytes')
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'folder').mkdir()
            bad = b'folder/Game_\xc1\xd0.jar'
            fd = os.open(os.fsencode(root) + b'/' + bad, os.O_CREAT | os.O_WRONLY, 0o600)
            os.close(fd)
            listed = mini.staged_file_paths(root)
            self.assertEqual(list(listed), [bad.decode('utf-8', errors='replace')])
            self.assertEqual(os.fsencode(next(iter(listed.values())).relative_to(root).as_posix()), bad)

    def test_mini_manifest_restores_bad_filename_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            db_path = base / 'mini.sqlite'
            db = sqlite3.connect(db_path)
            mini.ensure_schema(db)
            db.execute('CREATE TABLE mini_raw_paths (member_id INTEGER PRIMARY KEY, raw_member_path BLOB NOT NULL)')
            raw = b'folder/Game_\xc1\xd0.jar'
            listing = raw.decode('utf-8', errors='replace')
            db.execute('''INSERT INTO mini_members
                (id, package_name, member_path, declared_size, declared_crc32, actual_size,
                 actual_crc32, sha1, sha256, manifest_json)
                VALUES (1, ?, ?, 42, '1234ABCD', 42, '1234ABCD', ?, ?, '{}')''',
                       ('#.7z', listing, 'a' * 40, 'b' * 64))
            db.execute('INSERT INTO mini_raw_paths VALUES (1, ?)', (raw,))
            db.commit()
            db.close()
            original_expected, original_packages = assemble.EXPECTED_MINI, assemble.PACKAGES
            try:
                assemble.EXPECTED_MINI = 1
                assemble.PACKAGES = {'#.7z'}
                output = base / 'mini.csv'
                assemble.generate_mini_manifest(db_path, output)
                with output.open(encoding='utf-8', newline='') as file:
                    row = next(csv.DictReader(file))
                self.assertEqual(row['internal_path'], r'folder/Game_\udcc1\udcd0.jar')
            finally:
                assemble.EXPECTED_MINI, assemble.PACKAGES = original_expected, original_packages

    def test_original_manifest_can_be_parsed_without_reference_data(self):
        with tempfile.TemporaryDirectory() as td:
            jar = Path(td) / 'sample.jar'
            with zipfile.ZipFile(jar, 'w') as z:
                z.writestr('META-INF/MANIFEST.MF',
                           'Manifest-Version: 1.0\r\nMIDlet-Name: Sample \r\n Name\r\n\r\n')
            attrs, problem = mini.manifest_from_jar(jar)
            self.assertIsNone(problem)
            self.assertIn('"MIDlet-Name": "Sample Name"', attrs)

    def test_combined_row_uses_original_archive_path(self):
        row = combined.source_row('JARchive v11', 'games/Game.jar', 42,
                                  '1234abcd', 'a' * 40, 'b' * 64, 'JARchive_v11.7z')
        self.assertEqual(row[1:5], ('Game.jar', 'games/Game.jar', '42', '1234ABCD'))


if __name__ == '__main__':
    unittest.main()
