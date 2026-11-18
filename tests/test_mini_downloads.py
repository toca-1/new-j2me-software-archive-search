"""Tests for the supplementary SHA-1 -> Internet Archive 7z member map."""
import csv
import contextlib
import hashlib
import io
import subprocess
import zipfile
from unittest import mock
import gzip
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'tools' / 'build_mini_downloads.py'
spec = importlib.util.spec_from_file_location('build_mini_downloads', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CLI_SCRIPT = SCRIPT.parents[1] / 'jarchive_download.py'
cli_spec = importlib.util.spec_from_file_location('jarchive_download', CLI_SCRIPT)
cli = importlib.util.module_from_spec(cli_spec)
cli_spec.loader.exec_module(cli)


class MiniDownloadsTests(unittest.TestCase):
    def test_7z_url_encodes_inner_slashes_and_archive_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            manifest = base/'mini_sha1_manifest.csv'
            names = ['007 Top Agent/007JamesBondTopAgent_02C998DC.jar',
                     'E dobavki Demo/28755492_11D725C2.jar',
                     'T-Mobile Team Cycling/T-Mobile_Team_Cycling_by_BFLM_891E16F8.jar']
            archives = ['#.7z', 'E-G.7z', 'T-Z.7z']
            hashes = ['4014d1fb1cb9e95d58a58c7c3487a079e66baff2',
                      'efccefaa197beb983fafabf1a378ba5d084e2b41',
                      '42e851ea4e2e30eda491940b59f518266ceee4e7']
            with manifest.open('w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=['sha1','filename','archive','internal_path','size_bytes'])
                writer.writeheader()
                for a, h, p in zip(archives, hashes, names):
                    writer.writerow(dict(sha1=h, filename=p.rsplit('/',1)[-1],
                                         archive=a,internal_path=p,size_bytes=100))
            module.build(manifest, base/'mini', expected_rows=3)
            def lookup(sha1):
                with gzip.open(base/'mini'/f'{sha1[:2]}.json.gz','rt',encoding='utf-8') as f:
                    return json.load(f)[sha1]
            self.assertEqual(lookup(hashes[0])[2],
                             '%23.7z/007%20Top%20Agent%2F007JamesBondTopAgent_02C998DC.jar')
            self.assertEqual(lookup(hashes[1])[2],
                             'E-G.7z/E%20dobavki%20Demo%2F28755492_11D725C2.jar')
            self.assertEqual(lookup(hashes[2])[2],
                             'T-Z.7z/T-Mobile%20Team%20Cycling%2FT-Mobile_Team_Cycling_by_BFLM_891E16F8.jar')
            self.assertEqual(json.loads((base/'mini'/'manifest.json').read_text())['rows'], 3)

    def test_cli_map_mini_only_not_all_mini_links(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            jar_bytes = b'dummy jar bytes for indexing'
            sha1 = hashlib.sha1(jar_bytes).hexdigest()
            sha256 = hashlib.sha256(jar_bytes).hexdigest()
            manifest = base / 'source.csv'
            with manifest.open('w', encoding='utf-8', newline='') as f:
                w = csv.DictWriter(f, fieldnames=['sha1', 'archive', 'internal_path',
                                                  'filename', 'size_bytes'])
                w.writeheader()
                w.writerow(dict(sha1=sha1, archive='#.7z',
                                internal_path='007 Top Agent/007 Bond.jar',
                                filename='007 Bond.jar', size_bytes=len(jar_bytes)))
            catalog = base / 'v2.csv'
            with catalog.open('w', encoding='utf-8', newline='') as f:
                w = csv.DictWriter(f, fieldnames=['sha1','sha256','collection',
                                                  'size_bytes','crc32'])
                w.writeheader()
                w.writerow(dict(sha1=sha1, sha256=sha256,
                                collection='96x65pixels J2ME mini',
                                size_bytes=len(jar_bytes), crc32='A1B2C3D4'))
                w.writerow(dict(sha1='a'*40, sha256='b'*64,
                                collection='JARchive v11', size_bytes=35, crc32='00000000'))
            module.build(manifest, base / 'mini', expected_rows=1, catalog=catalog)
            raw = (base / 'mini' / 'cli.json.gz').read_bytes()
            matched = cli.load_mini_jar_map(raw, sha256)
            self.assertEqual(matched['sha1'], sha1)
            self.assertEqual(matched['crc'], 'A1B2C3D4')
            self.assertEqual(matched['url'],
                             cli.MINI_BASE_URL + '%23.7z/007%20Top%20Agent%2F007%20Bond.jar')
            self.assertEqual(cli.load_mini_jar_map(raw, sha1), matched)
            self.assertIsNone(cli.load_mini_jar_map(raw, 'b'*64))
            self.assertLess(len(raw), 2048)

            # Verify that the existing v1 map can report a missing SHA-256
            # without preventing the Mini-only fallback in automatic mode.
            old = base / 'retrieval'
            (old / 'sha256').mkdir(parents=True)
            (old / 'manifest.json').write_text(json.dumps({
                'schema_version': 1, 'source_item': cli.ITEM,
                'sha256_prefix_length': 1,
                'archives': [{}, {}], 'dictionary_mib': 64,
            }))
            with gzip.open(old / 'sha256' / f'{sha256[:1]}.json.gz', 'wt') as f:
                json.dump({}, f)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(cli.main([sha256, '--index', str(old),
                                           '--mini-map', str(base/'mini'/'cli.json.gz'),
                                           '--dry-run']), 0)
            self.assertIn('Mini-only source:', output.getvalue())
            (old / 'sha1').mkdir()
            with gzip.open(old / 'sha1' / f'{sha1[:2]}.json.gz', 'wt') as f:
                json.dump({}, f)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(cli.main([sha1, '--index', str(old),
                                           '--mini-map', str(base/'mini'/'cli.json.gz'),
                                           '--dry-run']), 0)
            self.assertIn('Mini-only source:', output.getvalue())
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(cli.main([sha256, '--source', 'mini',
                                           '--mini-map', str(base/'mini'/'cli.json.gz'),
                                           '--dry-run']), 0)
            self.assertIn('Mini-only source:', output.getvalue())

    def test_mini_cli_rejects_bad_map_and_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            jar = io.BytesIO()
            with zipfile.ZipFile(jar, 'w') as z:
                z.writestr('META-INF/MANIFEST.MF', 'MIDlet-Name: Test\n')
            good = jar.getvalue()
            import zlib
            source = dict(sha1=hashlib.sha1(good).hexdigest(),
                          sha256=hashlib.sha256(good).hexdigest(),
                          size=len(good), crc=f'{zlib.crc32(good):08X}',
                          url=cli.MINI_BASE_URL + 'A-B.7z/Some%20File.jar')
            def fake_curl(command, **kwargs):
                dest = Path(command[command.index('--output') + 1])
                dest.write_bytes(good)
                return subprocess.CompletedProcess(command, 0, b'200', b'')
            with mock.patch.object(cli.subprocess, 'run', side_effect=fake_curl):
                self.assertEqual(cli.download_mini_jar(
                    source, connect_timeout=5, request_timeout=20,
                    max_jar_mib=128, max_download_mib=512,
                    absolute_deadline=None), good)
                corrupt = dict(source, sha256='f'*64)
                with self.assertRaisesRegex(cli.RetrievalError, 'SHA-256 mismatch'):
                    cli.download_mini_jar(corrupt, connect_timeout=5,
                        request_timeout=20, max_jar_mib=128,
                        max_download_mib=512, absolute_deadline=None)
            bad = {'version': 1, 'item': cli.MINI_ITEM,
                   'sha256': {source['sha256']:
                       [source['sha1'], 'https://evil.example/evil.jar',
                        source['size'], source['crc']]},
                   'sha1': {source['sha1']: source['sha256']}}
            raw = gzip.compress(json.dumps(bad).encode(), mtime=0)
            with self.assertRaisesRegex(cli.RetrievalError, 'invalid Mini download entry'):
                cli.load_mini_jar_map(raw, source['sha256'])

    def test_unrepresentable_filename_byte_is_url_escaped(self):
        self.assertEqual(module.filename_bytes(r'dir/X_\udcff.jar'), b'dir/X_\xff.jar')


if __name__ == '__main__':
    unittest.main()
