#!/usr/bin/env python3
"""Fast, offline checks for source files and checked-in metadata.

No generated index shards, downloads, or third-party Python modules required.
Run from any directory with: python3 tests/check_repo.py
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCALES = ROOT / 'assets' / 'locales'
VARIABLE = re.compile(r'\{([A-Za-z_][A-Za-z_0-9]*)\}')
LITERAL_TRANSLATION = re.compile(r"\bt\(\s*['\"]([^'\"]+)['\"]")
HTML_TRANSLATION = re.compile(r'\bdata-i18n(?:-[a-z-]+)?="([^"]+)"')


def get_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def variables(value):
    if isinstance(value, str):
        return set(VARIABLE.findall(value))
    if isinstance(value, dict):
        return set().union(*(variables(v) for v in value.values()))
    raise AssertionError(f'Expected a string or plural-form object, got {type(value).__name__}')


class RepositoryChecks(unittest.TestCase):
    def test_python_source_syntax(self):
        paths = [ROOT / 'jarchive_download.py', ROOT / 'tests' / 'check_repo.py']
        paths.extend((ROOT / 'tools').glob('*.py'))
        for path in paths:
            with self.subTest(file=path.relative_to(ROOT)):
                compile(path.read_bytes(), str(path), 'exec')

    def test_all_locales_have_the_same_keys_and_variables(self):
        english = get_json(LOCALES / 'en.json')
        files = sorted(LOCALES.glob('*.json'))
        self.assertGreaterEqual(len(files), 2, 'No translation files found')
        self.assertTrue(english)
        for file in files:
            with self.subTest(language=file.stem):
                translated = get_json(file)
                self.assertEqual(set(translated), set(english), 'Translation keys differ from en.json')
                for key, value in translated.items():
                    with self.subTest(language=file.stem, key=key):
                        self.assertEqual(variables(value), variables(english[key]),
                                         'Translation placeholders differ from en.json')
                        if isinstance(value, dict):
                            self.assertIn('other', value, 'Plural translations need an "other" form')
                            self.assertTrue(all(isinstance(v, str) and v for v in value.values()))
                        else:
                            self.assertIsInstance(value, str)
                            self.assertTrue(value.strip(), 'Empty translation')

    def test_static_translation_references_exist(self):
        available = set(get_json(LOCALES / 'en.json'))
        for relative in ('index.html', 'assets/app.js', 'assets/i18n.js'):
            contents = (ROOT / relative).read_text(encoding='utf-8')
            referenced = set(LITERAL_TRANSLATION.findall(contents))
            if relative == 'index.html':
                referenced |= set(HTML_TRANSLATION.findall(contents))
            with self.subTest(file=relative):
                self.assertFalse(referenced - available,
                                 f'Unknown English keys: {sorted(referenced - available)}')

    def test_embedded_translation_tables_were_migrated(self):
        app = (ROOT / 'assets' / 'app.js').read_text(encoding='utf-8')
        for old_name in ('FOLDER_UI', 'SHOW_ALL_LABELS', 'sourceHeading'):
            self.assertNotIn(old_name, app, f'Embedded translation code remains: {old_name}')
        english = get_json(LOCALES / 'en.json')
        for key in ('folderOther', 'folderCounter', 'folderView', 'showAllRemaining',
                    'downloadToggle', 'downloadHeadingInternetArchive',
                    'downloadHeadingOtherMirrors'):
            self.assertIn(key, english)
        self.assertNotIn('downloadLinks', english)
        self.assertNotIn('downloadLinksOtherMirrors', english)

    def test_hash_search_hints_are_concise_and_punctuated(self):
        for file in sorted(LOCALES.glob('*.json')):
            with self.subTest(language=file.stem):
                locale = get_json(file)
                hint = locale['hintHashAuto']
                detected = locale['detectedHash']
                self.assertTrue(all(length in hint for length in ('8', '40', '64')))
                # A single instruction sentence; don't repeat that the type is detected.
                self.assertEqual(len(re.findall(r'[.!?。।]', hint)), 1)
                self.assertIn('{hash}', detected)
                self.assertTrue(detected.endswith(('.', '。', '।')),
                                'Detected-hash hint needs punctuation before the hosting notice')

    def test_homepage_referenced_assets_exist(self):
        html = (ROOT / 'index.html').read_text(encoding='utf-8')
        for attribute in ('src', 'href'):
            for name in re.findall(rf'\b{attribute}="([^"]+)"', html):
                if not name.startswith('assets/'):
                    continue  # External links and the home link are not local asset files.
                with self.subTest(asset=name):
                    self.assertTrue((ROOT / name.split('?', 1)[0].split('#', 1)[0]).is_file(),
                                    f'Broken homepage asset: {name}')

    def test_checked_in_manifest_and_build_summary_agree(self):
        manifest = get_json(ROOT / 'data' / 'manifest.json')
        summary = get_json(ROOT / 'data' / 'build-summary.json')
        self.assertEqual(manifest['schema_version'], 4)
        self.assertGreater(manifest['record_chunk'], 0)
        self.assertGreater(manifest['names_chunks'], 0)
        self.assertEqual(manifest['total_rows'], manifest['lite_rows'] + manifest['full_rows'])
        self.assertEqual(manifest['unique_files'],
                         manifest['shared_files'] + manifest['lite_only'] + manifest['full_only'])
        self.assertEqual(manifest['lite_rows'], manifest['shared_files'] + manifest['lite_only'])
        self.assertEqual(manifest['full_rows'], manifest['shared_files'] + manifest['full_only'])
        for field, summary_field in (
            ('total_rows', 'rows'), ('unique_files', 'unique_content'),
            ('search_terms', 'search_terms'), ('shared_files', 'shared'),
            ('lite_only', 'lite_only'), ('full_only', 'full_only'),
            ('max_original_paths', 'max_original_paths'),
        ):
            with self.subTest(field=field):
                self.assertEqual(manifest[field], summary[summary_field])


if __name__ == '__main__':
    unittest.main(verbosity=2)
