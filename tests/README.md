# Testing

Requires **Python 3.9+** and **Node.js 18+**; no pip/npm packages are needed. Run from the repository root.

## Source and regression tests (no generated index needed)

```sh
python3 tests/check_repo.py
python3 -m unittest discover -s tests -p 'test_*.py'
node --check assets/app.js
node --check assets/i18n.js
node --test tests/app.test.cjs
```

These cover repository assets/translations, indexing and rebuild logic using small synthetic fixtures, and browser search/UI behavior. In a source-only checkout, the repository check skips manifest/summary consistency when **both** files are absent.

## Before deploying (complete `data/` required)

```sh
python3 tests/check_index.py
python3 tools/check_folder_index.py --repo . --require-folders
```

The first is a **quick sample-based smoke check**; the second verifies folder compatibility with every record shard. The Pages workflow performs its own pre-deployment checks.

For a new or substantially changed index, also run the **exhaustive, read-only** core validator:

```sh
python3 tools/check_full_index.py --repo .
```

It checks all records, details, checksum lookups, searchable names and n-gram maps, using temporary SQLite files. If temporary space is limited, add `--temp-dir /existing/large/directory`. It does **not** hash the original JAR bytes or test remote download URLs. For rebuilding, see [`docs/REBUILD_ALL.md`](../docs/REBUILD_ALL.md).
