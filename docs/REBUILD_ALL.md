# Complete candidate search-index rebuild — one command

`tools/rebuild_all.py` is the **single command-line entry point** for the
current JARchive search-index reconstruction. It orchestrates the already-tested
Python tools under `tools/`; it does **not** duplicate them, require you to run
each manually, or overwrite the published index.

**Crucial limitation:** This is a **reference-backed reconstruction**. The
original four `.7z` archives alone are **not sufficient**: the existing,
exhaustively validated published `data/` index is also required to supply the
original SHA-1/SHA-256 values and primary metadata. The program reads 7z
archive *inventories*, not all JAR bytes; it **does not independently hash the
JAR contents**. For the independent byte-hashing procedure and provenance,
see [REPRODUCIBILITY.md](REPRODUCIBILITY.md).

## Prerequisites

- Python 3.9+ and **7-Zip** (`7z`; Ubuntu: `sudo apt install 7zip`). Only
  Python's standard library is required by the scripts.
- A checkout containing the **complete** already-published `data/` directory
  (including all `records/`, `details/`, `names-v2/`, `sha1/`, `sha256/` and
  `crc32/` shards). A source-only Git ZIP is insufficient.
- `JARchiveLite_v11.7z`, `JARchive_v11.7z`,
  `JARchiveLite_v11_infofiles.7z`, and `JARchive_v11_infofiles.7z`. The example
  assumes they're all in one directory. No JAR extraction to disk is needed.
- Free disk space for the SQLite working databases, the ~550 MiB enrichment
  inputs, the main index, supplemental indexes, and temporary staging; choose
  an output location with ample space.

## Rebuild everything supported by the local source archives

From the repository root on Ubuntu:

```sh
mkdir -p "$HOME/j2me-index-builds"

python3 tools/rebuild_all.py \
  --reference-data ./data \
  --archive-dir "$HOME/j2me-96x65pixels-test" \
  --out "$HOME/j2me-index-builds/full-site-candidate-01"
```

The output path **must not exist**. It must be outside the repository, archive
folder, and reference index. The script will not delete or replace an existing
directory. If you run it again, select `full-site-candidate-02`, etc. This
command does **not deploy** or modify any existing website files.

If the four archives aren't in the same directory, supply `--lite-archive`,
`--full-archive`, `--lite-info`, and `--full-info` with explicit paths. These
options also accept **complete** saved `7z l -slt` text inventories or complete
extracted infofile JSON; they must not be truncated.

### Reuse the enrichment you already reconstructed

If `enrichment-candidate-01/` already contains the two complete enriched files,
you can avoid listing the solid archives again:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --enriched-dir "$HOME/j2me-index-builds/enrichment-candidate-01" \
  --out "$HOME/j2me-index-builds/full-site-from-enriched-01"
```

The files are copied into the new candidate, so it remains self-contained.
In this mode `7z` and the original archive files are not needed for this run;
the provenance remains **reference-backed**, and the archive inventory must
have been verified when the enrichment was originally created.

## What the single command runs

1. Exhaustive **read-only validation** of the existing reference index.
2. Reconstruct and audit all **816,215 archive entries** with
   `reconstruct_enrichment.py` (or copy the already reconstructed enriched CSV
   and JSONL.gz). CRC32 ambiguities are rejected rather than guessed.
3. Build the main current-format index with `build_site.py`, including its
   **620,287 distinct JAR records**, 1,024 published-layout name-search
   shards, metadata details, CRC32/SHA-1/SHA-256 lookup buckets, and Unicode
   2/3-gram mappings. The main builder runs full validation itself.
4. Regenerate `data/folders/` and `data/search-summaries/` for the candidate.
5. Revalidate the folder fingerprint and exhaustively validate the main index.
6. SHA-256-compare **every core index file** to the reference, compare the
   manifest JSON values, and compare every searchable name entry in sequence
   and every shard boundary. Unexpected data differences **abort publication**.
7. When present, **copy** the reference's separate `data/upstream/` and
   `retrieval/v1/` download mappings, but only if all generated core record
   shards are byte-identical to the reference. This is a preservation/copy,
   **not a regeneration or independent validation of external download links**.
   Missing optional mappings are reported, not invented. Use
   `--no-copy-reference-extras` to omit them explicitly.
8. Write a `rebuild-report.json` with the audit, core hash results, provenance,
   and optional-asset status; publish the candidate atomically at the new path.

For the published dataset, the final hash results already observed were **336
exact compressed/JSON matches**, **1,040 gzip-encoding-only differences**, **2
JSON-serialization-only differences**, and **one stale historical
`build-summary.json` difference**. The original name-shard `.gz` files include
filename/timestamp headers and different DEFLATE streams; merely copying the
old timestamps into new files would **not** reproduce their compressed bytes.
The new pipeline intentionally emits deterministic gzip where possible.

## Output layout

```text
full-site-candidate-01/
  enrichment/
    jarchive-enriched.csv
    jarchive-enriched-details.jsonl.gz
    reconstruction-audit.json        # when reconstructed from archives
  data/
    manifest.json
    build-summary.json
    records/  details/  crc32/  sha1/  sha256/  names-v2/
    folders/                      # regenerated
    search-summaries/             # regenerated
    upstream/                     # copied only if available and safe
  retrieval/v1/                  # copied only if available and safe
  rebuild-report.json            # verification and provenance
```

To preview the candidate website **without deploying it**, serve a temporary
*copy* of the website files with this candidate's `data/` as a separate local
site. Do not copy candidate `data/` into the existing checkout without a
separate deployment review.

## Safety and validation semantics

The pipeline stages its output in a hidden sibling directory and publishes
only after all checks pass. Failed or interrupted runs leave the named output
unpublished. If a crash leaves a hidden `.j2me-all-staging-*` directory, inspect
it before manual cleanup; no existing named candidate is overwritten.

`--temp-dir /path/to/existing/directory` places temporary SQLite files on
another volume. `--strict-info` makes manifest mismatches and fallback metadata
fatal. `--expected-rows` and `--expected-unique` default to **816215** and
**620287**. The default schema settings use `--record-chunk 4096`,
`--name-shards 1024`, and `--max-original-paths 2`; altering them changes
published equivalence and will generally fail the final comparison. For
synthetic testing only, smaller expected counts and shard settings are allowed.

The final comparison permits changes to **gzip byte encoding**, differences in
JSON serialization (but **not JSON values**), and the published
`build-summary.json` bookkeeping discrepancy. It does **not** ignore changed
record bytes, missing/extra core files, changed manifests, altered searchable
names, or different name-shard boundaries. Source `data/upstream/` and the
separate downloader retrieval index are not covered by the core-file SHA
comparison and are explicitly recorded as reused if copied.

**This rebuild verifies compatibility with the published dataset, not the
cryptographic authenticity of the original `.jar` contents.** A complete
independent reconstruction would still require streaming and hashing the
original JAR bytes and reconstructing every external upstream mapping from
its own source packages.

For stage-specific details and separate/manual commands see
[BUILD_SITE.md](BUILD_SITE.md),
[RECONSTRUCT_ENRICHMENT.md](RECONSTRUCT_ENRICHMENT.md), and
[REBUILD_VERIFICATION.md](REBUILD_VERIFICATION.md) (record of the 2026-11-17
full-archive verification).
