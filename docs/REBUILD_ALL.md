# Rebuild the search index

`tools/rebuild_all.py` generates a **new, validated candidate** without changing the published `data/` or deploying anything. The rebuild is **reference-backed**: it requires the existing index as well as the original JARchive inputs.

## Requirements

- Python **3.9+** and **7-Zip** (`7z`; on Ubuntu: `sudo apt install 7zip`) for archive-based reconstruction.
- A checkout containing the complete published `data/` directory.
- Four archives in one directory: `JARchiveLite_v11.7z`, `JARchive_v11.7z`, `JARchiveLite_v11_infofiles.7z`, `JARchive_v11_infofiles.7z` ([original collection](https://archive.org/details/96x65pixels_j2me)).
- Disk space for temporary SQLite files and a **new output directory** outside the repository.

## Run

From the repository root:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --archive-dir /path/to/four-archives \
  --out /path/to/new-candidate
```

Or reuse an existing directory containing `jarchive-enriched.csv` and `jarchive-enriched-details.jsonl.gz`:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --enriched-dir /path/to/enrichment \
  --out /path/to/another-new-candidate
```

Use `--temp-dir` for temporary SQLite files on another volume, `--strict-info` to reject metadata fallbacks, or `--no-copy-reference-extras` to omit separately sourced download mappings.

## Output and limitations

The candidate contains `enrichment/`, `data/` (including folder browsing and search summaries), and `rebuild-report.json`. Reconstruction checks archive-member paths, sizes and CRC32s against the reference, joining **Full infofiles by SHA-256** and **Lite infofiles by CRC32** with collision checks. It validates the rebuilt index and compares its contents with the published version.

**SHA-1/SHA-256 and primary metadata come from the existing index:** the rebuild does *not* independently hash every JAR. Historical gzip encoding and `build-summary.json` accounting may differ even when the searchable data matches. Optional `data/upstream/` and `retrieval/v1/` mappings are **copied**, not independently regenerated. See [test commands](../tests/README.md) and [source coverage](SOURCES.md).

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
