# Rebuild the search index

`tools/rebuild_all.py` produces a **new, validated candidate** without changing the published `data/` or deploying anything. It is **reference-backed**: the existing index supplies SHA-1/SHA-256 and primary metadata; the original archives alone cannot recreate it independently.

## Requirements

- Python **3.9+** and, when using the archives, **7-Zip** (`7z`; Ubuntu: `sudo apt install 7zip`). No Python packages are required.
- A checkout with the **complete published `data/` directory**, not just the source ZIP.
- Four original archives in one directory: `JARchiveLite_v11.7z`, `JARchive_v11.7z`, `JARchiveLite_v11_infofiles.7z`, `JARchive_v11_infofiles.7z` — or previously reconstructed enrichment files.
- Enough disk space for temporary SQLite data and a new index. Choose a **nonexistent output directory outside this repository**.

## Run

From the repository root:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --archive-dir /path/to/four-7z-files \
  --out /path/to/new-candidate
```

To skip archive reconstruction, reuse a directory containing `jarchive-enriched.csv` and `jarchive-enriched-details.jsonl.gz`:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --enriched-dir /path/to/enrichment \
  --out /path/to/another-new-candidate
```

Use `--lite-archive`, `--full-archive`, `--lite-info` and `--full-info` if the four inputs aren't together. `--temp-dir /existing/directory` selects another volume for temporary SQLite files; `--strict-info` rejects infofile fallbacks.

## Output and checks

The candidate contains `enrichment/`, `data/` (core index, `folders/`, `search-summaries/`) and `rebuild-report.json`. The tool validates both indexes and compares all core files against the reference. Different gzip encodings and historical `build-summary.json` accounting are allowed; **changed search data, names or shard boundaries are not**.

Optional `data/upstream/` and `retrieval/v1/` download mappings are **copied**, not regenerated or URL-checked, when safe. Use `--no-copy-reference-extras` to omit them. Review the report before using the candidate; nothing is deployed automatically.

The real-data workflow reproduced **816,215 archive entries**, **620,287 unique contents** and **2,056,525 name entries**. It does **not** rehash all JAR bytes. See [reproducibility and streaming hashes](REPRODUCIBILITY.md) or [test commands](../tests/README.md).
