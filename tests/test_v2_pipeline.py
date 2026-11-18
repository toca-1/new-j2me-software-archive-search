"""Small end-to-end fixture for the optional third archive (no production data needed)."""
import csv
import gzip
import hashlib
import json
import sys
import tempfile
import unittest
import zlib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from build_site import build as build_index
from check_full_index import check_full_index
from prepare_v2 import build as prepare_v2
from verify_v2 import verify as verify_v2
from rebuild_all import rebuild_v2, RebuildError


class V2Pipeline(unittest.TestCase):
    def test_adds_mini_without_modifying_old_records(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            def digest(raw):
                return hashlib.sha256(raw).hexdigest(), hashlib.sha1(raw).hexdigest()
            sha256_a, sha1_a = digest(b'a')
            sha256_b, sha1_b = digest(b'b')
            fields = [
                'collection','filename','archive_path','size_bytes','crc32','sha1',
                'sha256','archive_file','metadata_status','midlet_name','midlet_vendor',
                'midlet_version','cldc','midp'
            ]
            old_csv = root / 'old.csv'
            with old_csv.open('w', encoding='utf-8', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=fields)
                writer.writeheader()
                for row in [
                    ['JARchiveLite v11','A.jar','A/A.jar',1,'11111111',sha1_a,sha256_a,'JARchiveLite_v11.7z','matched','A','Vendor','1','',''],
                    ['JARchive v11','AB.jar','AB/AB.jar',1,'11111111',sha1_a,sha256_a,'JARchive_v11.7z','matched','A','Vendor','1','',''],
                    ['JARchive v11','B.jar','B/B.jar',1,'22222222',sha1_b,sha256_b,'JARchive_v11.7z','matched','B','Vendor','1','',''],
                ]:
                    writer.writerow(dict(zip(fields, row)))
            details_path = root / 'old_details.jsonl.gz'
            with gzip.open(details_path, 'wt', encoding='utf-8') as f:
                for coll, sha, path, count in [
                    ('JARchiveLite v11',sha256_a,'A/A.jar',4),
                    ('JARchive v11',sha256_a,'AB/AB.jar',3),
                    ('JARchive v11',sha256_b,'B/B.jar',1)
                ]:
                    f.write(json.dumps({'collection':coll,'sha256':sha,
                                        'manifest':{'MIDlet-Name':'A'},
                                        'paths':[path],'path_count':count})+'\n')
            old = root/'old_data'
            build_index(source=old_csv,details=details_path,out=old,
                        expected_count=3,expected_unique=2,
                        record_chunk=2,name_shards=4)
            jar = root/'extracted'/'#'/'007 Top Agent'/'Bond.jar'
            jar.parent.mkdir(parents=True)
            with zipfile.ZipFile(jar,'w') as f:
                f.writestr('META-INF/MANIFEST.MF',
                           'Manifest-Version: 1.0\r\nMIDlet-Name: Bond Test\r\n'
                           'MIDlet-Vendor: Example\r\n')
            new_sha256,new_sha1 = digest(jar.read_bytes())
            mini_csv = root/'mini.csv'
            with mini_csv.open('w',encoding='utf-8',newline='') as f:
                writer=csv.DictWriter(f,fieldnames=fields[:8]); writer.writeheader()
                writer.writerow({'collection':'96x65pixels J2ME mini',
                                 'filename':'Bond.jar',
                                 'archive_path':'007 Top Agent/Bond.jar',
                                 'size_bytes':jar.stat().st_size,
                                 'crc32':f'{zlib.crc32(jar.read_bytes()):08X}','sha1':new_sha1,
                                 'sha256':new_sha256,'archive_file':'#.7z'})
            enrichment = root/'enrichment'
            # Reject a manipulated inventory even when JAR size is unchanged.
            bad_mini_csv = root / 'mini-tampered.csv'
            with bad_mini_csv.open('w', encoding='utf-8', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=fields[:8])
                writer.writeheader()
                writer.writerow({'collection':'96x65pixels J2ME mini',
                                 'filename':'Bond.jar',
                                 'archive_path':'007 Top Agent/Bond.jar',
                                 'size_bytes':jar.stat().st_size,
                                 'crc32':f'{zlib.crc32(jar.read_bytes()):08X}',
                                 'sha1':new_sha1,
                                 'sha256':'0' * 64, 'archive_file':'#.7z'})
            with self.assertRaisesRegex(ValueError, 'Mini JAR bytes'):
                prepare_v2(old,bad_mini_csv,root/'extracted',root/'bad_enrichment',
                           expected_base=2,expected_extra=1,expected_rows=3)
            self.assertFalse((root/'bad_enrichment').exists())
            prepare_v2(old,mini_csv,root/'extracted',enrichment,
                       expected_base=2,expected_extra=1,expected_rows=3)
            new = root/'new_data'
            build_index(source=enrichment/'jarchive-enriched.csv',
                        details=enrichment/'jarchive-enriched-details.jsonl.gz',
                        out=new,expected_count=4,expected_unique=3,
                        record_chunk=2,name_shards=4)
            verify_v2(old,new,mini_csv,expected_old=2,expected_new=3,
                      expected_rows=4,expected_mini=1)
            self.assertIn('Full index validation passed',check_full_index(new))
            manifest=json.loads((new/'manifest.json').read_text())
            self.assertEqual(manifest['mini_rows'],1)
            self.assertEqual(manifest['mini_only'],1)
            self.assertEqual(manifest['unique_files'],3)

            # The public one-command entry point must reconstruct the old
            # reference first, then build and verify a complete Mini v2 index.
            base_enrichment = root / 'base_enrichment'
            base_enrichment.mkdir()
            (base_enrichment / 'jarchive-enriched.csv').write_bytes(old_csv.read_bytes())
            (base_enrichment / 'jarchive-enriched-details.jsonl.gz').write_bytes(
                details_path.read_bytes())
            mini_manifest = root / 'mini_sha1_manifest.csv'
            with mini_manifest.open('w', encoding='utf-8', newline='') as stream:
                w = csv.DictWriter(stream, fieldnames=(
                    'sha1', 'archive', 'internal_path', 'filename', 'size_bytes'))
                w.writeheader()
                w.writerow({'sha1':new_sha1, 'archive':'#.7z',
                            'internal_path':'007 Top Agent/Bond.jar',
                            'filename':'Bond.jar', 'size_bytes':jar.stat().st_size})
            # Separately sourced assets should be copied, never reconstructed.
            (old / 'upstream').mkdir()
            (old / 'upstream' / 'test.json').write_text('old-upstream')
            (root / 'retrieval/v1').mkdir(parents=True)
            (root / 'retrieval/v1/manifest.json').write_text('old-retrieval')
            candidate = root / 'one_command_v2'
            report = rebuild_v2(
                reference=old, out=candidate, enriched_dir=base_enrichment,
                expected_rows=3, expected_unique=2, record_chunk=2,
                name_shards=4, copy_reference_extras=True,
                mini_csv=mini_csv, mini_extracted=root/'extracted',
                mini_manifest=mini_manifest,
                combined_csv=enrichment/'jarchive-enriched.csv',
                mini_extra=1, mini_link_rows=1)
            self.assertEqual(report['unique_jar_contents'], 3)
            self.assertEqual(report['mini_download_rows'], 1)
            self.assertEqual(json.loads((candidate/'data/manifest.json').read_text())['mini_only'], 1)
            self.assertTrue((candidate/'data/mini/cli.json.gz').is_file())
            self.assertTrue((candidate/'rebuild-report.json').is_file())
            self.assertEqual((candidate/'data/upstream/test.json').read_text(), 'old-upstream')
            self.assertEqual((candidate/'retrieval/v1/manifest.json').read_text(), 'old-retrieval')
            with self.assertRaisesRegex(RebuildError, 'Reference counts do not match'):
                rebuild_v2(reference=candidate/'data', out=root/'wrong_reference',
                           enriched_dir=base_enrichment, expected_rows=3,
                           expected_unique=2, mini_csv=mini_csv,
                           mini_extracted=root/'extracted', mini_manifest=mini_manifest,
                           combined_csv=enrichment/'jarchive-enriched.csv',
                           mini_extra=1, mini_link_rows=1)
            self.assertFalse((root/'wrong_reference').exists())
            with self.assertRaisesRegex(RebuildError, 'already exists'):
                rebuild_v2(reference=old, out=candidate,
                           enriched_dir=base_enrichment, expected_rows=3,
                           expected_unique=2, mini_csv=mini_csv,
                           mini_extracted=root/'extracted', mini_manifest=mini_manifest,
                           combined_csv=enrichment/'jarchive-enriched.csv',
                           mini_extra=1, mini_link_rows=1)


if __name__ == '__main__':
    unittest.main()
