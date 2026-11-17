# Offline pre-deployment regression checks

These checks need **Python 3** and **Node.js 18+**; there are no pip or npm dependencies.
They do not download or rebuild the large J2ME index.

From the repository root:

```sh
python3 tests/check_repo.py
node --check assets/app.js
node --check assets/i18n.js
node --test tests/app.test.cjs
python3 -m unittest discover -s tests -p 'test_check_index.py'
python3 -m unittest discover -s tests -p 'test_full_index.py'
python3 -m unittest discover -s tests -p 'test_folder_index.py'
python3 -m unittest discover -s tests -p 'test_search_summaries.py'
```

To check a **complete checkout containing the generated `data/` shards** before deploying:

```sh
python3 tests/check_index.py
python3 tools/check_folder_index.py --repo . --require-folders
```

Before a **major index rebuild**, optionally run the exhaustive, read-only
validator. It is intentionally excluded from the quick test suite and GitHub
Pages deployment workflow because it decompresses every core shard and may
require substantial time and temporary disk space:

```sh
python3 tools/check_full_index.py --repo .
# When your system temporary directory is too small:
python3 tools/check_full_index.py --repo . --temp-dir /path/to/a/large/temp-directory
```

The directory passed to `--temp-dir` must already exist. Temporary SQLite
files are removed automatically; the generated `data/` directory is not
modified. A nonzero exit status indicates an integrity failure. This check
verifies record and detail structure, per-collection source counts, SHA-1,
SHA-256, CRC32 collisions and coverage, every searchable name label and ID,
and the exact gram-to-name-shard bitmaps. It does not rehash original JAR bytes,
check remote download links, or validate optional supplemental indexes.
The full validator uses the canonical name fields (all source filenames,
primary MIDlet title, and vendor) case-insensitively; if the separate site
builder intentionally changes its name normalization, update this contract.


The source-only ZIP does **not** include `data/` at all. The offline tests
above use synthetic data and can run without it; the manifest/summary consistency
check is skipped if *both* files are absent. If only one exists, the test fails.
`check_index.py` deliberately **fails** without the complete generated index.
Run it in a checkout containing all generated shards.

- `check_repo.py` checks Python syntax, translation keys, placeholders, and the native-language catalog, local HTML assets, and (when present) consistency between the checked-in summary and manifest.
- `app.test.cjs` tests selected functions from the real `assets/app.js` with lightweight mocks: URL encoding, name-shard selection/search caching, CRC32 collisions, exact SHA-256 lookup, refinement/sorting, retry handling, and the download/folder disclosure interaction.
- `test_check_index.py` exercises the index smoke checker against a small synthetic dataset, including deliberately missing shards and damaged gzip content; it does not require the generated archive.
- `test_full_index.py` exercises the exhaustive validator against tiny complete synthetic indexes and deliberately corrupted hash/name/record/detail assets; it does not require the generated archive.
- `check_index.py` runs on the actual generated index: checks expected record/detail and hash-shard counts, verifies every name shard referenced by the gram map exists, and decompresses representative shards. It does **not** read every record, validate individual download URLs, or require optional upstream/folder indexes.
- `test_folder_index.py` builds tiny folder indexes and proves that reordering records or changing source paths is detected even when the main manifest is unchanged.
- `tools/check_folder_index.py` verifies the v2 folder fingerprint against **all** current record shards; it is a deliberately more expensive check and must be run after regenerating `data/folders/`. The Pages workflow runs it when the optional folder index is present. `--require-folders` also fails if it is absent.
- The Pages deployment workflow runs the offline checks, the synthetic Python smoke-check tests, **and** the real index smoke check before preparing or uploading the site. A failure stops that deployment; the previously published site stays online. A deployable checkout must have the generated `data/` files.

**Limits:** These checks are not a browser end-to-end test. The smoke check samples rather than exhaustively validating generated shards and does not validate live Internet Archive/mirror URLs. Keep manual VM/browser testing for changes affecting rendering, download links and new index builds.
