# New J2ME Software Archive Search

[Search J2ME games, apps, and exact JAR builds](https://toca-1.github.io/new-j2me-software-archive-search/) by filename, title, vendor, or various hashes (CRC32, SHA-1, SHA-256). A current browser with JavaScript enabled is required.

This independent index covers [TwoSpacesSG's "New J2ME Software Archive"](https://archive.org/details/96x65pixels_j2me) (JARchive Full/Lite v11) and the [96x65pixels J2ME Mini collection](https://archive.org/details/96x65pixels_j2me_mini), plus separate links to matching upstream sources described in [`SOURCES.md`](SOURCES.md). The current v2 search index holds 621,715 unique JAR contents from 817,643 archive-source entries (including 1,428 new Mini-only JARs). For an alternative visual exploration of the archive refer to [this website](https://f.nnproject.cc/jarchive/).

## Search features

There are two main search modes:
1. **Text search**

Case-insensitive text search of original filenames, MIDlet names, and vendors, as well as search-within-results refinement and sorting by title or file size. This supports multiple search terms, `"exact phrases"`, `-term` exclusions, as well as metadata operations like `@version=x.x` (see [Search help](https://toca-1.github.io/new-j2me-software-archive-search/html/search-help.html) for detailed instructions)

2. **Hash search**

A single Hash search mode which automatically detects complete CRC32, SHA-1, or SHA-256 checksums

---

Moreover, the following information and features are available once a search has been conducted:
- MIDlet name, vendor, version, CLDC, and MIDP information where available
- Direct download links to individual JAR files on the Internet Archive and other mirror sites, together with alternative downloader instructions and copyable commands for Windows and Linux/macOS
- Page through matching files in groups of 5 by default (adjustable to 10, 20, or 50), with Previous/Next, numbered pages, and a clickable ellipsis for direct page jumps; switching sort order or refinement starts again at page 1
- Export the full current search result set, including refinements and sorting (up to 10,000 unique files per export, not just the visible page)
- Expandable manifest details and historical original-source locations
- Expandable "Other files" browser for distinct JAR contents in the same archive folder with filtering
## Obtain the verified file indexes

The current [index-v2 release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v2) contains `jarchive-combined-verified-v2.csv.gz`, its `.sha256` checksum, and an acceptance report for the expanded three-collection index. The historical [index-v1 release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) remains available as the reference for rebuilding the original Full/Lite index. The CSVs record archive paths, filenames, sizes, CRC32, SHA-1, and SHA-256 values; they **do not contain JAR bytes**.

## Run or rebuild locally

For a full v2 rebuild you need the **v1 reference index**, the four original JARchive inputs (or reconstructed v1 enrichment), and the prepared Mini inventories and extracted Mini-only JARs. From the repository root, run:

```sh
python3 tools/rebuild_all.py \
  --reference-data /path/to/v1-checkout/data \
  --archive-dir /path/to/jarchive-archives \
  --mini-only-csv /path/to/mini_only_enriched.csv \
  --mini-extracted /path/to/mini/extracted \
  --mini-manifest /path/to/mini_sha1_manifest.csv \
  --combined-csv /path/to/jarchive-combined-verified-v2.csv \
  --out /path/to/new-v2-output
```

This first reproduces v1 against its historical reference, then builds and validates the Mini-expanded v2 index, folder browser, search summaries, and Mini download maps. The output must be a new directory, and separately sourced upstream mirrors are copied, not regenerated. To preview the website locally, run `python3 -m http.server 8000` and open <http://localhost:8000/>. For prerequisites, limitations and detailed instructions, see [`REBUILD_ALL.md`](REBUILD_ALL.md). To assess missing or conflicting MIDlet metadata and discover candidate manifest fields for later research, see [`METADATA_QUALITY.md`](METADATA_QUALITY.md) and run `python3 tools/audit_metadata.py --data ./data --out /path/to/new-report-directory`.

## Downloads, third-party content, and licensing

This project is independently developed and is not affiliated with or endorsed by TwoSpacesSG, the archive contributors, or the Internet Archive. An optional Python downloader retrieves portions of the original Full/Lite archives, or downloads verified individual Mini-only JARs, from the Internet Archive.

**This project does not host or bundle the archived JAR files.**

The project's software license applies only to its original code and documentation, except where otherwise noted. It does not grant rights to archived software, archive-derived datasets, or other third-party content. Archived files remain subject to their respective rights holders, and availability through the Internet Archive does not imply that they are freely licensed. Users are responsible for ensuring their downloads and use comply with applicable laws.

## Usage of AI

Parts of this project were developed with substantial ChatGPT assistance and were not all reviewed line by line. The indexing, search and downloader workflows were tested, including manual Linux/Windows tests, but this cannot guarantee correct operation for every file, browser or configuration.

