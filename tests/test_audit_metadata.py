"""Small synthetic tests for offline metadata availability and conflict auditing."""
import csv
import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import audit_metadata as checker


def dump(path, value, *, compressed=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False).encode('utf-8')
    path.write_bytes(gzip.compress(payload, mtime=0) if compressed else payload)


class MetadataQualityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        dump(self.data / 'manifest.json', {
            'schema_version': 4, 'unique_files': 3,
            'record_chunk': 2, 'total_rows': 5,
        })
        dump(self.data / 'records/0000.json.gz', [
            ['a' * 64, '1' * 40, 5,
             [[0, 'A.jar', 'A/A.jar', '11111111'],
              [1, 'A.jar', 'A/A.jar', '11111111']],
             ['A', 'Acme', '', 'CLDC-1.1', 'MIDP-2.0']],
            ['b' * 64, '2' * 40, 10,
             [[0, 'B.jar', 'B/B.jar', '22222222']],
             ['', '', '  ', '', '']],
        ], compressed=True)
        dump(self.data / 'details/0000.json.gz', [
            [[0, {'MIDlet-Name': 'A', 'MIDlet-Version': '2.0',
                  'MIDlet-Vendor': 'Other'}, [], 0],
             [1, {'MIDlet-Name': 'A', 'MIDlet-Version': '1.0',
                  'MIDlet-Vendor': 'Acme', 'Nokia-MIDlet-Original-Display-Size': '240x320',
                  'Custom-Formula': '=1+1'},
              [], 0]],
            [[0, {'MIDlet-Version': '', 'Language': 'ru',
                  'Screen-Resolution': '128x160', 'MIDlet-Vendor': 'B Corp'}, [], 0]],
        ], compressed=True)
        dump(self.data / 'records/0001.json.gz', [
            ['c' * 64, '3' * 40, 15,
             [[1, 'C.jar', 'C/C.jar', '33333333'],
              [1, 'C2.jar', 'C/C2.jar', '44444444']],
             ['C', 'Example', '3.0', '', '']],
        ], compressed=True)
        dump(self.data / 'details/0001.json.gz', [
            [[1, {'MIDlet-Name': 'C', 'MIDlet-Version': '4.0',
                  'midlet-version': '5.0', 'MIDlet-Vendor': 'Example'}, [], 0]],
        ], compressed=True)

    def test_audit_counts_and_field_discovery(self):
        report, inventory, examples = checker.audit(self.data, max_examples=1)
        self.assertEqual(report['unique_files'], 3)
        self.assertEqual(report['archive_member_sources'], 5)
        self.assertEqual(report['collection_detail_pairs'], 4)
        self.assertEqual(report['primary_fields']['version'], {'missing': 2, 'present': 1})
        self.assertEqual(report['collections']['JARchiveLite v11']['detail_pairs'], 2)
        self.assertEqual(report['collections']['JARchive v11']['detail_pairs'], 2)
        self.assertEqual(report['observations']['primary_missing_manifest_present']['version'], 1)
        self.assertEqual(report['observations']['primary_missing_manifest_present']['vendor'], 1)
        self.assertEqual(report['observations']['cross_collection_difference']['version'], 1)
        self.assertEqual(report['observations']['cross_collection_difference']['vendor'], 1)
        self.assertEqual(report['observations']['primary_manifest_difference']['version'], 1)
        self.assertEqual(report['observations']['intra_manifest_conflict']['midlet-version'], 1)
        self.assertEqual(report['observations']['source_crc_disagreement']['(general)'], 1)
        self.assertEqual(inventory['midlet-version'][:2], [4, 3])
        self.assertEqual(inventory['nokia-midlet-original-display-size'][:2], [1, 1])
        self.assertEqual(inventory['screen-resolution'][:2], [1, 1])
        self.assertEqual(report['possible_extension_key_types'], 3)
        self.assertLessEqual(len(checker.audit(self.data, max_total_examples=2)[2]), 2)
        self.assertEqual(sum(x['issue'] == 'primary_missing_manifest_present' and x['field'] == 'version'
                             for x in examples), 1)

    def test_cli_writes_bounded_reports_and_does_not_modify_source(self):
        before = {str(path.relative_to(self.data)): path.read_bytes()
                  for path in self.data.rglob('*') if path.is_file()}
        output = self.root / 'result'
        result = subprocess.run([sys.executable, str(ROOT / 'tools/audit_metadata.py'),
                                 '--data', str(self.data), '--out', str(output),
                                 '--max-examples', '0'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(path.name for path in output.iterdir()),
                         {'summary.json', 'manifest-fields.csv', 'possible-extension-fields.csv',
                          'examples.csv'})
        self.assertEqual(json.loads((output / 'summary.json').read_text())['unique_files'], 3)
        with (output / 'examples.csv').open(newline='') as stream:
            self.assertEqual(len(list(csv.DictReader(stream))), 0)
        with (output / 'possible-extension-fields.csv').open(newline='') as stream:
            names = {row['canonical_key'] for row in csv.DictReader(stream)}
        self.assertEqual(names, {'language', 'screen-resolution',
                                 'nokia-midlet-original-display-size'})
        with (output / 'manifest-fields.csv').open(newline='') as stream:
            exported = {row['canonical_key']: row for row in csv.DictReader(stream)}
        self.assertEqual(exported['custom-formula']['example_value'], "'=1+1")
        self.assertEqual(before, {str(path.relative_to(self.data)): path.read_bytes()
                                  for path in self.data.rglob('*') if path.is_file()})
        second = subprocess.run([sys.executable, str(ROOT / 'tools/audit_metadata.py'),
                                 '--data', str(self.data), '--out', str(output)],
                                capture_output=True, text=True)
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('Refusing to overwrite', second.stderr)

    def test_corrupted_source_refused_without_partial_output(self):
        path = self.data / 'details/0001.json.gz'
        path.write_bytes(b'invalid-gzip')
        out = self.root / 'no-report'
        result = subprocess.run([sys.executable, str(ROOT / 'tools/audit_metadata.py'),
                                 '--data', str(self.data), '--out', str(out)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(out.exists())

    def test_output_cannot_be_inside_index(self):
        result = subprocess.run([sys.executable, str(ROOT / 'tools/audit_metadata.py'),
                                 '--data', str(self.data),
                                 '--out', str(self.data / 'reports')],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.data / 'reports').exists())

    def test_literal_question_mark_is_not_blank(self):
        path = self.data / 'records/0000.json.gz'
        rows = checker.read_json(path, gz=True)
        rows[0][4][2] = '?'
        dump(path, rows, compressed=True)
        report, _, _ = checker.audit(self.data)
        self.assertEqual(report['primary_fields']['version']['missing'], 2 - 1)
        self.assertEqual(report['primary_fields']['version']['placeholder_like'], 1)

    def test_limit_validation(self):
        with self.assertRaisesRegex(ValueError, 'Example limits'):
            checker.audit(self.data, max_examples=-1)
        with self.assertRaisesRegex(ValueError, 'Example limits'):
            checker.audit(self.data, max_total_examples=-1)


if __name__ == '__main__':
    unittest.main()
