# Upstream files not found in JARchive v11 / Lite v11

This directory tracks *potential* gaps identified by hashing JARs in upstream
collections and comparing their SHA-256 checksums against the existing verified
JARchive index. A missing SHA-256 match does **not** establish that a game or
application is otherwise absent: it could be a modified, repacked, or damaged
copy of a file that's already indexed.

## Inventories

- `waptrick_unmatched.csv` — [Waptrick](https://archive.org/details/dump_waptrick_240x320_128x160), scanned 2026-11-09. Seven ZIP files contained 11,789 JAR entries with 10,796 unique hashes; 10,255 unique hashes matched the JARchive index and 541 did not. The CSV retains all distinct ZIP/member paths for those unmatched hashes (possibly more than 541 rows).

Columns: `sha256`, `zip_file`, `zip_member`, `size_bytes`, and `member_url`.
The URLs are candidate links to members inside the original ZIPs. No JAR
binaries are stored in this repository. Scanner outputs and original ZIPs are
kept outside the website repository.

Additional upstream collections can be added here using their own
`<collection>_unmatched.csv` files. Files in this directory do not update the
published search index or its download links.

A change confined to `missing_files/` is ignored by the Pages deployment
workflow. A commit that also changes site files will still trigger deployment.
