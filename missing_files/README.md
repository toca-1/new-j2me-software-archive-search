# Upstream files not found in JARchive v11 / Lite v11

This directory tracks potential gaps identified by hashing JARs in upstream collections and comparing their SHA-256 checksums against the existing verified JARchive index

## Inventories

- `all_unmatched_deduplicated.csv` (main inventory): 134,110 distinct SHA-256 hashes, with all recorded source archives and file locations preserved in `source_archives` and `locations_json`.
- `*_unmatched.csv`: Original per-source inventories retained for reference. Column names and available metadata vary by source.

The consolidated inventory also records file sizes where known and whether a candidate direct-download URL exists. For detailed archive coverage and methodology, see [SOURCES.md](../docs/SOURCES.md).
