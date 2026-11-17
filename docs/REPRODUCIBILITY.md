# Reproducibility and independent verification

The supported current rebuild is [`REBUILD_ALL.md`](REBUILD_ALL.md): `tools/rebuild_all.py` reconstructs a new, validated candidate index from the original Lite/Full 7z inventories, their metadata infofiles, **and the existing validated `data/` index**. This reference-backed process was tested on all **816,215** archive entries and reproduced **620,287** unique records and **2,056,525** searchable names with identical name-shard boundaries. It does **not** recalculate SHA-1/SHA-256 from JAR contents or independently regenerate separate upstream/retrieval mappings.

This page preserves the steps needed to check original content independently, the metadata-join rationale, and the recovered historical builder's role.

## Original inputs and published inventory

The [Internet Archive collection](https://archive.org/details/96x65pixels_j2me) supplies `JARchiveLite_v11.7z`, `JARchive_v11.7z` and their corresponding `*_infofiles.7z` archives (not distributed by this source repository). The [index-v1 release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) contains the verified base inventory (`jarchive-combined-verified.csv.gz`), its published `.sha256` checksum and a summary.

For reproducible provenance, record the original archive URLs, retrieval dates and `sha256sum` values. Check the published inventory before using it:

```sh
sha256sum -c jarchive-combined-verified.csv.gz.sha256
gzip -t jarchive-combined-verified.csv.gz
```

The release digest checks the downloaded CSV against the **publisher's supplied digest**. It does not independently prove the archived JARs' contents. The 816,215 archive-member occurrences are not 816,215 unique files: copies with identical SHA-256 remain separate locations attached to one content record.

## Independently hash a JAR, including overlong filenames

The identity of a JAR is the checksum of its **uncompressed JAR bytes**, not its containing `.7z` or ZIP. Some archive filenames exceed Linux's maximum individual path-component length; do not attempt to extract those names onto disk. Instead, stream **one exact archive member** from `7z` into Python:

```bash
ARCHIVE='/path/to/JARchive_v11.7z'
MEMBER='exact/path/inside/archive/file.jar'
set -o pipefail
7z x -so "$ARCHIVE" "$MEMBER" | python3 -c '
import hashlib, sys, zlib
sha1, sha256 = hashlib.sha1(), hashlib.sha256()
size, crc = 0, 0
for chunk in iter(lambda: sys.stdin.buffer.read(1024 * 1024), b""):
    sha1.update(chunk); sha256.update(chunk)
    crc = zlib.crc32(chunk, crc); size += len(chunk)
if size == 0:
    raise SystemExit("Empty stream: check that exactly one JAR was selected")
print("bytes:", size, "CRC32:", f"{crc:08x}")
print("SHA-1:", sha1.hexdigest(), "SHA-256:", sha256.hexdigest())
'
```

First use `7z l -slt "$ARCHIVE"` to inspect archive paths. **Check that only the intended member was selected**, especially when a name includes wildcard characters. `set -o pipefail` prevents a failing `7z` extraction from looking successful merely because the hash command exited cleanly. The source is streamed without creating its filename on disk; a solid 7z archive may still require substantial decompression. Compare the output size and hashes against the published inventory. For nested ZIPs/JARs, Python's `zipfile.ZipFile(...).open(member)` similarly avoids extracting an overlong filename.

This is a repeatable *independent hash check*, not a claim that this exact command was used in the historical scan. To independently verify **every** JAR would require streaming all its bytes; `rebuild_all.py` deliberately does not do that.

## Metadata association and reconstructed enrichment

- Preserve each occurrence's Lite/Full collection, exact 7z member path, filename, size and CRC32, even for duplicate contents. Hash **bytes**, not filenames; SHA-256 is the identity key. CRC32 collisions are possible.
- Inside JARs, `META-INF/MANIFEST.MF` may contain `MIDlet-Name`, `MIDlet-Vendor`, `MIDlet-Version`, `MicroEdition-Profile` and `MicroEdition-Configuration`. Fields can be missing, wrapped or contradictory; don't invent absent metadata.
- The Full infofile's JSON is keyed by SHA-256; the Lite infofile uses CRC32. The reference-backed `tools/reconstruct_enrichment.py` verifies archive-member inventories against the published index, resolves matches with collision safeguards, and restores original source paths/metadata from the infofiles. It emits `jarchive-enriched.csv`, `jarchive-enriched-details.jsonl.gz` and an audit report. The modern `tools/build_site.py` consumes these to build `names-v2/`, records, details and checksum indexes; the one-command wrapper also builds folder and search-summary indexes.
- The *original historical* enrichment/extraction scripts have not been recovered. The reconstructed files faithfully reproduce the **published logical index**, not a separately proven end-to-end ingest from original bytes. Upstream download scans and `retrieval/v1/` generation remain distinct processes ([source coverage](SOURCES.md)).

## Recovered historical v4 builder

The old `build_site.py` was removed in commit `97a3b2f`. Its last committed version remains accessible in Git history:

```sh
git show '97a3b2f^:build_site.py' > /tmp/jarchive-build-site-v4.py
python3 /tmp/jarchive-build-site-v4.py --help
```

It read enriched CSV plus gzipped JSONL metadata, grouped archive occurrences by SHA-256, preferred Full metadata for primary display fields, and generated records/details, SHA-1/SHA-256/CRC32 lookups and an old `data/names/` search index. Its defaults included `--expected-count 816215`, `--record-chunk 4096`, `--name-shards 64` and `--max-original-paths 2`. It was **not** the current `names-v2` builder; setting `--name-shards 1024` would not upgrade it. Worse, a successful historical run replaced the target's `data/` directory. **Never run it on the live checkout.** The separately tested successor is `tools/build_site.py`, orchestrated by `tools/rebuild_all.py`.

## What the final verification establishes

Our real-data candidate rebuild passed exhaustive core and folder checks. All **1,379 core paths** were present in both indexes. **336** files were byte-identical by SHA-256; **1,040** had identical decompressed bytes but different gzip encodings; **two** had equal JSON values but different serialization; and **one**, `build-summary.json`, held different accounting values (the published summary's file count was stale relative to its current name-shard layout). The complete ordered stream of **2,056,525** searchable names and its **1,024** shard boundaries matched exactly.

Thus the currently supported pipeline reproduces the *logical content* of the published core index, not every historical compressed-file SHA-256. See [`REBUILD_ALL.md`](REBUILD_ALL.md) for executable commands, automatic comparisons and output safety. Original JAR-byte authentication, external link availability and independently generated upstream indexes are **not** established by these checks.
