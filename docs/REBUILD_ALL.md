# One-command candidate index rebuild

Use **`tools/rebuild_all.py`** to reconstruct and verify a new copy of the J2ME site's search data. The program runs the existing `tools/` scripts in order; there is no need to invoke their stages manually. It **never overwrites** the published `data/` directory or an existing output path.

**This rebuild is reference-backed.** The original four 7z archives alone are insufficient: an existing fully validated `data/` tree supplies SHA-1/SHA-256 identifiers and primary metadata. The archives' member listings and infofiles are checked and joined, but JAR contents are **not independently rehashed**. The [reproducibility notes](REPRODUCIBILITY.md) explain how to hash individual JARs—including Linux-overlong filenames—and what remains outside this rebuild.

## Requirements

- Python 3.9+, standard library only. For original archive inputs install **7-Zip** (`sudo apt install 7zip` on Ubuntu; command `7z`).
- The complete existing published `data/` tree, including `records/`, `details/`, `names-v2/`, `crc32/`, `sha1/`, `sha256/` and `manifest.json`. **Source-only ZIPs do not include these large generated files.**
- In one directory: `JARchiveLite_v11.7z`, `JARchive_v11.7z`, `JARchiveLite_v11_infofiles.7z`, `JARchive_v11_infofiles.7z`; alternatively an existing complete enriched CSV/JSONL pair.
- Free space for temporary SQLite work, roughly 550 MiB of enrichment files, and both core and supplementary indexes. The output must be a **new directory outside the reference index and repository**.

## Rebuild from the original archive inventories

Run from a checkout containing the complete published index:

```sh
mkdir -p "$HOME/j2me-index-builds"
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --archive-dir "$HOME/j2me-96x65pixels-test" \
  --out "$HOME/j2me-index-builds/full-site-candidate-01"
```

Use `--lite-archive`, `--full-archive`, `--lite-info`, `--full-info` if the archives live in different directories. Each also accepts an independently saved **complete** archive listing/metadata file (not a truncated sample).

To reuse previously reconstructed enrichment files instead of scanning the archives again:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --enriched-dir "$HOME/j2me-index-builds/enrichment-candidate-01" \
  --out "$HOME/j2me-index-builds/from-enriched-01"
```

The enrichment directory must contain `jarchive-enriched.csv` and `jarchive-enriched-details.jsonl.gz`. The script copies them into the new candidate. Select a different **nonexistent** output directory for another run. Neither command deploys anything.

## What it runs and verifies

1. Exhaustively validate the existing reference index.
2. Reconstruct/audit the original **816,215 archive entries**, or reuse complete enriched inputs. CRC32 ambiguities cannot be silently guessed.
3. Rebuild the core search index: **620,287 unique contents**, **1,024 `names-v2` shards**, records/details and CRC32/SHA-1/SHA-256 lookups. The core builder includes its own exhaustive validation.
4. Rebuild `data/folders/` and `data/search-summaries/`; validate folder compatibility and the core index again.
5. Compare SHA-256 of all core files to the reference; also check equivalent decompressed data/JSON values, the complete per-shard searchable-name contents and boundaries (without an additional global scan). **Unexpected changes abort publication.**
6. Where safe and present, **copy** reference `data/upstream/` and `retrieval/v1/` download mappings (not regenerate or independently validate them). Run with `--no-copy-reference-extras` to omit these copies.
7. Write `rebuild-report.json` and atomically publish the candidate directory.

The core comparison tolerates different gzip bytes/JSON formatting but not changed logical index data. The published `build-summary.json` contains older size/file-count bookkeeping; the new builder reports its own accurate generated totals. This difference is documented in the report. The original `names-v2` gzip files also contain timestamps/filenames and DEFLATE streams different from the modern builder, so **bit-for-bit compressed-file SHA-256 equality is not expected**. The recorded real-data comparison is in [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).

Typical output:

```text
full-site-candidate-01/
  enrichment/              # enriched CSV, JSONL.gz and optional reconstruction audit
  data/                    # current core index
    records/ details/ crc32/ sha1/ sha256/ names-v2/
    folders/ search-summaries/
    upstream/              # only if safely copied from reference
  retrieval/v1/            # only if safely copied from reference
  rebuild-report.json      # provenance and verification results
```

The workflow stages files in a hidden sibling `.j2me-all-staging-*` directory and only publishes after all checks pass. On failure the named output is not published. If interrupted, inspect any leftover hidden staging directory before deleting it. A valid candidate is **not** automatically deployed; test the generated site separately before replacing any published files.

### Options and limitations

- `--temp-dir /existing/path` puts temporary SQLite databases on another volume.
- `--strict-info` treats any infofile-manifest disagreement or fallback as an error.
- Defaults: `--expected-rows 816215`, `--expected-unique 620287`, `--record-chunk 4096`, `--name-shards 1024`, `--max-original-paths 2`. Changing schema/sharding settings usually breaks reference equivalence; smaller values are useful only with synthetic inputs.
- Optional upstream/retrieval mappings are copied **only when core record files match the reference byte-for-byte**. Copied external links are not URL-audited by this tool.
- This verifies **compatibility with published search data**, not the authenticity of all archived JAR bytes. Original upstream scans and downloader-retrieval index generation require separate inputs/procedures.

For the test commands, see [`tests/README.md`](../tests/README.md). For independent byte hashing and historical pipeline context, see [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).
