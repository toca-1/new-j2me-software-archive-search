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
```

To check a **complete checkout containing the generated `data/` shards** before deploying:

```sh
python3 tests/check_index.py
```

The source-only ZIP does **not** include `data/` at all. The offline tests
above use synthetic data and can run without it; the manifest/summary consistency
check is skipped if *both* files are absent. If only one exists, the test fails.
`check_index.py` deliberately **fails** without the complete generated index.
Run it in a checkout containing all generated shards.

- `check_repo.py` checks Python syntax, translation keys and placeholders, local HTML assets, and (when present) consistency between the checked-in summary and manifest.
- `app.test.cjs` tests selected functions from the real `assets/app.js` with lightweight mocks: URL encoding, name-shard selection/search caching, CRC32 collisions, exact SHA-256 lookup, refinement/sorting, retry handling, and the download/folder disclosure interaction.
- `test_check_index.py` exercises the index smoke checker against a small synthetic dataset, including deliberately missing shards and damaged gzip content; it does not require the generated archive.
- `check_index.py` runs on the actual generated index: checks expected record/detail and hash-shard counts, verifies every name shard referenced by the gram map exists, and decompresses representative shards. It does **not** read every record, validate individual download URLs, or require optional upstream/folder indexes.
- The Pages deployment workflow runs the offline checks, the synthetic Python smoke-check tests, **and** the real index smoke check before preparing or uploading the site. A failure stops that deployment; the previously published site stays online. A deployable checkout must have the generated `data/` files.

**Limits:** This is not a browser end-to-end test. The smoke check samples rather than exhaustively validating generated shards and does not validate live Internet Archive/mirror URLs. Keep manual VM/browser testing for changes affecting rendering, download links and new index builds.
