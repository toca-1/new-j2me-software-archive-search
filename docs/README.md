# New J2ME Software Archive Search

[Search J2ME games, apps, and exact JAR builds](https://toca-1.github.io/new-j2me-software-archive-search/) by filename, title, vendor, or various hashes (CRC32, SHA-1, SHA-256). A current browser with JavaScript enabled is required.

This independent index covers [TwoSpacesSG's **New J2ME Software Archive**](https://archive.org/details/96x65pixels_j2me) as well as its upstream sources that are listed in the archive's description, cf. [`SOURCES.md`](SOURCES.md). For an alternative visual exploration of the archive refer to [this website](https://f.nnproject.cc/jarchive/).

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
## Obtain the verified base index

The [index-v1 release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) provides `jarchive-combined-verified.csv.gz`, its `.sha256` checksum and a verification summary. The CSV records archive paths, filenames, sizes, CRC32, SHA-1 and SHA-256 values.

## Run or rebuild locally

To rebuild the search index, you need a checkout containing the existing `data/` directory and the four original JARchive `.7z` archives. From the repository root, run:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --archive-dir /path/to/jarchive-archives \
  --out /path/to/new-output
```

This reconstructs the search index, metadata, folder browser and search summaries, then validates the results against the existing index (the output must be a new directory). To preview the website locally, run `python3 -m http.server 8000` and open <http://localhost:8000/>. For prerequisites, limitations and detailed instructions, see [`REBUILD_ALL.md`](REBUILD_ALL.md). To assess missing or conflicting MIDlet metadata and discover candidate manifest fields for later research, see [`METADATA_QUALITY.md`](METADATA_QUALITY.md) and run `python3 tools/audit_metadata.py --data ./data --out /path/to/new-report-directory`.

## Downloads, third-party content, and licensing

This project is independently developed and is not affiliated with or endorsed by TwoSpacesSG, the archive contributors, or the Internet Archive. An optional Python downloader retrieves portions of the original archives from the Internet Archive and reconstructs individual JAR files locally on the user's computer.

**This project does not host or bundle the archived JAR files.**

The project's software license applies only to its original code and documentation, except where otherwise noted. It does not grant rights to archived software, archive-derived datasets, or other third-party content. Archived files remain subject to their respective rights holders, and availability through the Internet Archive does not imply that they are freely licensed. Users are responsible for ensuring their downloads and use comply with applicable laws.

## Usage of AI

Parts of this project were developed with substantial ChatGPT assistance and were not all reviewed line by line. The indexing, search and downloader workflows were tested, including manual Linux/Windows tests, but this cannot guarantee correct operation for every file, browser or configuration.
