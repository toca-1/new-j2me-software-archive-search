# Testing

Requires **Python 3.9+** and **Node.js 18+**.

## Source and regression tests (no generated index needed)

To cover repository assets/translations, indexing and independent rebuild logic using small synthetic fixtures, and browser search/UI behavior:

```sh
python3 tests/check_repo.py
python3 -m unittest discover -s tests -p 'test_*.py'
node --check assets/app.js
node --check assets/i18n.js
node --test tests/app.test.cjs tests/mini_downloads.test.cjs
```

## Before deploying (complete `data/` required)

```sh
python3 tests/check_index.py
python3 tools/check_folder_index.py --repo . --require-folders
```

The first is a quick sample-based smoke check, while the second verifies folder compatibility with every record shard. For a new or substantially changed index, also run the exhaustive (read-only) core validator:

```sh
python3 tools/check_full_index.py --repo .
```

It checks all records, details, checksum lookups, searchable names and n-gram maps, using temporary SQLite files. If temporary space is limited, add `--temp-dir /existing/large/directory`.
