# Rebuild the search index (v1 and v2)

`tools/rebuild_all.py` builds a **new, validated candidate** without changing the published `data/` or deploying anything. **The reference must be the original v1 index**, not the current v2 index. The base reconstruction inherits v1 SHA-1/SHA-256 and metadata; Mini-only JAR bytes are independently checked when producing v2.

## Requirements

- Python **3.9+** and **7-Zip** (`7z`; on Ubuntu: `sudo apt install 7zip`) for archive-based reconstruction.
- A saved **pre-Mini, schema-4 v1 `data/` directory**, with **620,287** unique contents, **816,215** archive entries and the **1,024-shard `names-v2` index**. The current `main` branch contains **v2** and cannot serve as this reference. The [historical `index-v1` release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) includes the verified CSV, **not a substitute for the complete `data/` tree**; if using a checkout of the `index-v1` tag, verify its actual index layout first. A saved pre-Mini checkout or validated pre-Mini build output is suitable.
- Four archives in one directory (unless using `--enriched-dir` with saved v1 enrichment): `JARchiveLite_v11.7z`, `JARchive_v11.7z`, `JARchiveLite_v11_infofiles.7z`, `JARchive_v11_infofiles.7z` ([original collection](https://archive.org/details/96x65pixels_j2me)).
- For v2: the 1,428 Mini-only rows in `mini_only_enriched.csv`, the extracted Mini JARs arranged under their original package directories, `mini_sha1_manifest.csv` (all 225,867 Mini members), and `jarchive-combined-verified-v2.csv` from the [v2 release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v2) (decompress its `.csv.gz` first).
- Disk space for temporary SQLite files, the intermediate v1 rebuild, and a **new output directory** outside the repository. Mini-only JARs are read and hashed, not modified.

## Rebuild v2 (complete current search index)

From the repository root, with the four v1 archives and the separately prepared Mini inputs:

```sh
python3 tools/rebuild_all.py \
  --reference-data "/path/to/pre-mini-v1/data" \
  --archive-dir /path/to/four-v1-archives \
  --mini-only-csv /path/to/mini_only_enriched.csv \
  --mini-extracted /path/to/mini/extracted \
  --mini-manifest /path/to/mini_sha1_manifest.csv \
  --combined-csv /path/to/jarchive-combined-verified-v2.csv \
  --out /path/to/new-v2-candidate
```

The script reconstructs and compares the **v1** base first, then verifies the new Mini JAR bytes and builds **621,715** unique records across **817,643** source rows, 1,024 name shards, folder groups, search summaries, and both Mini URL indexes (including `data/mini/cli.json.gz`). It checks full-index integrity, folder compatibility, and preservation of every v1 record/detail. The candidate includes `enrichment/`, `data/`, a report, and any separately sourced v1 extras that were available. The normal v1 range downloader index under `retrieval/v1/` is preserved unchanged.

`--enriched-dir` can replace `--archive-dir` when you already have the **v1** reconstructed CSV and details JSONL.gz. Do **not** pass the combined v2 CSV there; Mini is integrated separately via the four `--mini-*` / `--combined-csv` flags.

## Rebuild v1 only (historical reference)

Omit all Mini arguments. From the repository root:

```sh
python3 tools/rebuild_all.py \
  --reference-data "/path/to/pre-mini-v1/data" \
  --archive-dir /path/to/four-archives \
  --out /path/to/new-candidate
```

Or reuse an existing directory containing `jarchive-enriched.csv` and `jarchive-enriched-details.jsonl.gz`:

```sh
python3 tools/rebuild_all.py \
  --reference-data "/path/to/pre-mini-v1/data" \
  --enriched-dir /path/to/v1-enrichment \
  --out /path/to/another-new-candidate
```

Use `--temp-dir` for temporary SQLite files on another volume, `--strict-info` to reject metadata fallbacks, or `--no-copy-reference-extras` to omit separately sourced download mappings.

## Output and limitations

Rebuilding v1 checks archive-member paths, sizes and CRC32s against the **v1 reference**, joining **Full infofiles by SHA-256** and **Lite infofiles by CRC32** with collision checks. It validates the rebuilt index and compares core contents with v1. v2 adds independently checked Mini-only JARs and validates preservation of the base.

Inputs such as `mini_only_enriched.csv`, `mini_sha1_manifest.csv`, and the complete v2 CSV must be supplied from the separately prepared Mini inventory; this tool does **not** rescan the Mini `.7z` packages to recreate those CSVs from scratch. It checks the extracted Mini-only JAR bytes against the supplied inventory. The full 225,867-member Mini mapping includes JARs that already existed in v1, but adds only 1,428 unique contents. The full Mini URL inventory is validated against the supplied combined CSV, not independently rehashed member-by-member. This is therefore a **verified rebuild from prepared inputs**, not a fully independent archive-cataloguing pipeline.

**For original v1 records, SHA-1/SHA-256 and primary metadata come from the historical reference:** the rebuild does *not* independently rehash those JARs. For Mini-only records, SHA-1/SHA-256, CRC32 and size are checked against the actual extracted JAR bytes; primary MIDlet metadata is extracted from those JARs. Historical gzip encoding and `build-summary.json` accounting may differ even when the searchable data matches. Optional `data/upstream/` and `retrieval/v1/` mappings are **copied from the v1 reference**, not independently regenerated. Original release snapshots should be retained for historical reproducibility. See [test commands](../tests/README.md) and [source coverage](SOURCES.md).

## Hash an archive member without extracting its filename

Some JAR member names exceed Linux's filename limit. Stream the **exact member** through a hash calculator instead of writing it to disk (Bash):

```bash
ARCHIVE='/path/to/JARchive_v11.7z'
MEMBER='exact/path/in/archive/file.jar'
set -o pipefail
7z x -so -spd "$ARCHIVE" "$MEMBER" | python3 -c '
import hashlib, sys, zlib
sha1, sha256 = hashlib.sha1(), hashlib.sha256()
size, crc = 0, 0
for block in iter(lambda: sys.stdin.buffer.read(1024 * 1024), b""):
    sha1.update(block); sha256.update(block)
    crc = zlib.crc32(block, crc); size += len(block)
if not size: raise SystemExit("Empty stream: verify the archive member")
print("bytes:", size, "CRC32:", f"{crc:08x}")
print("SHA-1:", sha1.hexdigest(), "SHA-256:", sha256.hexdigest())
'
```

Find the precise member path with `7z l -slt "$ARCHIVE"` and confirm that only one JAR is selected. `-spd` disables wildcard matching; `pipefail` detects extraction errors. Compare the hashes of the **uncompressed JAR bytes** with the published inventory. Solid archives may still require substantial decompression.
