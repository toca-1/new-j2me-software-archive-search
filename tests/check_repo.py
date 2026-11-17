#!/usr/bin/env python3
"""Fast, offline checks for source files and checked-in metadata.

No generated index shards, downloads, or third-party Python modules required.
Run from any directory with: python3 tests/check_repo.py
"""

import hashlib
import json
import re
from html.parser import HTMLParser
from xml.etree import ElementTree
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
        for relative in ('index.html', 'html/search-help.html', 'html/downloader-help.html', 'assets/app.js', 'assets/i18n.js'):
            contents = (ROOT / relative).read_text(encoding='utf-8')
            referenced = set(LITERAL_TRANSLATION.findall(contents))
            if relative.endswith('.html'):
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

    def test_help_pages_are_linked_localized_and_have_local_assets(self):
        homepage = (ROOT / 'index.html').read_text(encoding='utf-8')
        app = (ROOT / 'assets/app.js').read_text(encoding='utf-8')
        help_page = (ROOT / 'html/search-help.html').read_text(encoding='utf-8')
        guide_page = (ROOT / 'html/downloader-help.html').read_text(encoding='utf-8')
        helper_script = (ROOT / 'assets/help.js').read_text(encoding='utf-8')
        self.assertIn('id="search-help-link" href="./html/search-help.html"', homepage)
        self.assertIn('data-i18n="searchHelpLink"', homepage)
        self.assertIn("guide.href = './html/downloader-help.html'", app)
        self.assertIn('data-i18n-title="searchHelpLink"', help_page)
        self.assertIn('data-i18n-title="downloaderGuideTitle"', guide_page)
        self.assertIn('window.J2ME_I18N.init()', helper_script)
        self.assertIn('sonic -panasonic', help_page)
        self.assertIn('prince -persia', help_page)
        self.assertIn('content="Search help page for the J2ME search index"', help_page)
        self.assertNotIn('searchHelpMainText', help_page)
        self.assertIn('<strong data-i18n="refineHelpExamples">', help_page)
        revision = re.search(r"const LOCALE_REVISION = '([^']+)'",
                             (ROOT / 'assets/i18n.js').read_text(encoding='utf-8'))
        self.assertIsNotNone(revision)
        for name, page in [('html/search-help.html', help_page),
                           ('html/downloader-help.html', guide_page)]:
            with self.subTest(page=name):
                for asset in ('assets/i18n.js', 'assets/help.js', 'assets/site.css'):
                    self.assertIn('../' + asset + '?v=' + revision.group(1), page)
                for attr in ('src', 'href'):
                    for url in re.findall(rf'\b{attr}="(assets/[^"]+)"', page):
                        self.assertTrue((ROOT / 'html' / url.split('?', 1)[0]).is_file(),
                                        f'Broken {name} asset: {url}')

    def test_help_language_menus_match_main_site(self):
        # Keep standalone help-page language menus in the same native-name
        # alphabetical order as the main search page.
        class LanguageOptions(HTMLParser):
            def __init__(self):
                super().__init__()
                self.inside = False
                self.options = []
                self.code = None

            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                if tag == 'select' and attrs.get('id') == 'language-select':
                    self.inside = True
                elif tag == 'option' and self.inside:
                    self.code = attrs.get('value')

            def handle_data(self, data):
                if self.code is not None:
                    self.options.append((self.code, data.strip()))
                    self.code = None

            def handle_endtag(self, tag):
                if tag == 'select' and self.inside:
                    self.inside = False

        def menu(page):
            parser = LanguageOptions()
            parser.feed((ROOT / page).read_text(encoding='utf-8'))
            return parser.options

        expected = menu('index.html')
        self.assertEqual(len(expected), 22)
        self.assertEqual(len(set(code for code, _ in expected)), len(expected))
        self.assertEqual(set(code for code, _ in expected),
                         set(path.stem for path in LOCALES.glob('*.json')))
        for page in ('html/search-help.html', 'html/downloader-help.html'):
            with self.subTest(page=page):
                self.assertEqual(menu(page), expected)

    def test_rendered_downloader_guide_matches_markdown_source(self):
        # The rendered HTML is a copy of the maintained Markdown guide.
        # Detect source edits that require regenerating the static HTML page.
        markdown = (ROOT / 'docs' / 'DOWNLOADER.md').read_bytes()
        rendered = (ROOT / 'html/downloader-help.html').read_text(encoding='utf-8')
        digest = hashlib.sha256(markdown).hexdigest()
        self.assertIn(f'Source SHA-256 (docs/DOWNLOADER.md): {digest}', rendered,
                      'The Markdown guide changed; refresh html/downloader-help.html')
        for anchor in ('quick-start', 'how-it-works', 'full-command-line-options',
                       'errors-and-troubleshooting', 'privacy-trust-and-rights'):
            self.assertIn(f'id="{anchor}"', rendered)
        self.assertIn('jarchive_download.py YOUR_SHA1_OR_SHA256', rendered)
        self.assertIn('href="#errors-and-troubleshooting"', rendered)

    def test_homepage_seo_and_sharing_metadata(self):
        class HeadTags(HTMLParser):
            def __init__(self):
                super().__init__()
                self.tags = []
                self.title_text = ''
                self.in_title = False

            def handle_starttag(self, tag, attrs):
                if tag in ('meta', 'link'):
                    self.tags.append((tag, dict(attrs)))
                if tag == 'title':
                    self.in_title = True

            def handle_endtag(self, tag):
                if tag == 'title':
                    self.in_title = False

            def handle_data(self, text):
                if self.in_title:
                    self.title_text += text

        parser = HeadTags()
        parser.feed((ROOT / 'index.html').read_text(encoding='utf-8'))
        tags = parser.tags
        english = get_json(LOCALES / 'en.json')

        def meta(key, value):
            matches = [attrs['content'] for tag, attrs in tags if tag == 'meta'
                       and attrs.get(key) == value and 'content' in attrs]
            self.assertEqual(len(matches), 1, f'Expected one {key}={value} meta tag')
            return matches[0]

        def link(relation):
            matches = [attrs for tag, attrs in tags if tag == 'link'
                       and attrs.get('rel') == relation]
            self.assertEqual(len(matches), 1, f'Expected one {relation} link')
            return matches[0]

        self.assertEqual(parser.title_text, english['pageTitle'])
        self.assertEqual(meta('name', 'description'), english['metaDescription'])
        self.assertEqual(meta('property', 'og:title'), english['pageTitle'])
        self.assertEqual(meta('property', 'og:description'), english['metaDescription'])
        self.assertEqual(meta('property', 'og:site_name'), english['pageTitle'])
        self.assertEqual(meta('property', 'og:type'), 'website')
        self.assertEqual(meta('name', 'twitter:card'), 'summary')
        url = 'https://toca-1.github.io/new-j2me-software-archive-search/'
        self.assertEqual(meta('property', 'og:url'), url)
        self.assertEqual(link('canonical')['href'], url)
        favicon = link('icon')
        self.assertEqual(favicon.get('type'), 'image/svg+xml')
        self.assertEqual(favicon.get('href'), 'assets/favicon.svg')
        icon_file = ROOT / favicon['href']
        self.assertTrue(icon_file.is_file())
        self.assertEqual(ElementTree.parse(icon_file).getroot().tag,
                         '{http://www.w3.org/2000/svg}svg')
        html = (ROOT / 'index.html').read_text(encoding='utf-8')
        self.assertIn(english['heroSuffix'], html)
        self.assertIn(english['hostNotice'], html)
        revision = re.search(r"const LOCALE_REVISION = '([^']+)'", (ROOT / 'assets/i18n.js').read_text(encoding='utf-8'))
        self.assertIsNotNone(revision)
        self.assertIn('assets/i18n.js?v=' + revision.group(1), html)

    def test_checked_in_manifest_and_build_summary_agree(self):
        manifest_path = ROOT / 'data' / 'manifest.json'
        summary_path = ROOT / 'data' / 'build-summary.json'
        if not manifest_path.exists() and not summary_path.exists():
            self.skipTest('Source-only checkout: generated manifest/summary absent')
        self.assertTrue(manifest_path.is_file(), 'Missing data/manifest.json')
        self.assertTrue(summary_path.is_file(), 'Missing data/build-summary.json')
        manifest = get_json(manifest_path)
        summary = get_json(summary_path)
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
