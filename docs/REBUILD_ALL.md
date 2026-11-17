# Rebuild the search index

`tools/rebuild_all.py` produces a validated candidate without changing the published `data/` or deploying anything

## Requirements

- Python **3.9+** and, when using the archives, **7-Zip** (`7z`; Ubuntu: `sudo apt install 7zip`)
- A checkout with the complete published `data/` directory
- The four original archives `JARchiveLite_v11.7z`, `JARchive_v11.7z`, `JARchiveLite_v11_infofiles.7z`, `JARchive_v11_infofiles.7z` in one directory
- Enough disk space for temporary SQLite data and a new index

## Run

From the repository root:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --archive-dir /PATH/TO/FOUR-7Z-FILES \
  --out /PATH/TO/NEW-CANDIDATE
```

To skip archive reconstruction, reuse a directory containing `jarchive-enriched.csv` and `jarchive-enriched-details.jsonl.gz`:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --enriched-dir /PATH/TO/ENRICHMENT \
  --out /PATH/TO/ANOTHER-NEW-CANDIDATE
```

`--temp-dir` selects another volume for temporary SQLite files; `--strict-info` rejects infofile fallbacks

## Output and checks

The candidate contains `enrichment/`, `data/` (core index, `folders/`, `search-summaries/`) and `rebuild-report.json`. The tool validates both indexes and compares all core files against the reference. Optional `data/upstream/` and `retrieval/v1/` download mappings are copied; use `--no-copy-reference-extras` to omit them. Refer also to [reproducibility and streaming hashes](REPRODUCIBILITY.md) and [test commands](../tests/README.md).
