# Reproducibility and independent checks

The supported rebuild is [the one-command workflow](REBUILD_ALL.md). It joins the [original Lite/Full archive inventories and infofiles](https://archive.org/details/96x65pixels_j2me) to the existing validated `data/` index.

## Provenance and metadata

The [verified base-index release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) provides `jarchive-combined-verified.csv.gz` and its publisher-supplied `.sha256` file. After downloading both, check the CSV:

```sh
sha256sum -c jarchive-combined-verified.csv.gz.sha256
gzip -t jarchive-combined-verified.csv.gz
```

The checksum confirms agreement with the published inventory; there are 816,215 archive-member occurrences (including duplicates), representing 620,287 unique SHA-256 contents. Then, `tools/reconstruct_enrichment.py` checks exact archive paths, sizes and CRC32s against the reference. It joins **Full infofiles by SHA-256** and **Lite infofiles by CRC32**, with collision safeguards, preserving source locations and available manifest metadata. `tools/build_site.py` then builds the core index; `tools/rebuild_all.py` also builds folder and search-summary data. Missing or inconsistent metadata must not be silently invented.

## Independently hash a JAR without extracting its filename

Some member filenames exceed Linux's filesystem limit. Stream an **exact archive member** directly through a hash calculator instead of writing it to disk:

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

Find the exact member path using `7z l -slt "$ARCHIVE"`; confirm that only one JAR was selected. `-spd` disables wildcard matching, and `pipefail` detects 7-Zip errors. Solid archives can still require substantial decompression. Compare the resulting **uncompressed JAR-byte** hashes and size with the inventory.

## What was verified

The full-scale candidate passed exhaustive validation and reproduced all **2,056,525 searchable names** in the same **1,024 shards**. Of 1,379 core files, **336 matched byte-for-byte**, **1,040 had identical decompressed bytes**, **two had equal JSON values with different encoding**, and only the historical `build-summary.json` had different accounting values. Therefore the **logical index matches**, not every compressed-file SHA-256.

The original extraction scripts have not been recovered; a former v4 `build_site.py` in Git history (`97a3b2f^`) built the obsolete `names/` layout, **not** today's `names-v2/`. Separate upstream sources and downloader-retrieval mappings are **not independently regenerated** by this workflow; see [source coverage](SOURCES.md). Independent verification of *every* JAR requires streaming all original bytes.
