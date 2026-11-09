# Additional upstream download links

The site can show exact-match download links to upstream Internet Archive ZIP
members, alongside the original New J2ME Software Archive links. The initial
source is [Opera Mini](https://archive.org/details/opera-mini-j2me-archive).

## Opera Mini mapping

- The Opera Mini ZIP (`opera-mini-j2me.zip`) was scanned without unpacking JARs.
- `scan_opera_upstream.py` produced `opera_mini_matches.csv` by comparing every
  member's SHA-256 to the verified New archive index.
- This analysis found **6,932 JAR entries, 6,859 unique SHA-256 values**, all of
  which matched an existing indexed file. Duplicate ZIP members with the same
  SHA-256 are represented by one selected path in the site mapping.
- A sample ZIP-member URL was downloaded and the JAR SHA-256 was verified.
  This is not a guarantee of continued availability for every member link.

The generated site data is under `data/upstream/`. `sources.json` describes
upstream archive bases. The 16 `.json.gz` shards map SHA-256 hashes to source
indices and member paths, loaded only for displayed search results. Nothing is
added to the main search records, and the JAR files are *not* hosted here.

To regenerate after rescanning the ZIP, run the patch/generator script with its
`--matches` parameter from the repository root. The source CSV is deliberately
not committed (the repository's `.gitignore` excludes CSV files).

The separate optional terminal downloader is still available if browser links
return a timeout or HTTP 504. Other upstream collections can be added later,
with separate hash comparisons and ZIP-member URL tests.
