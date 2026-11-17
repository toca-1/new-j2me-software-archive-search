# New J2ME Software Archive Search

[Search J2ME games, apps, and exact JAR builds](https://toca-1.github.io/new-j2me-software-archive-search/) by filename, title, vendor, or various hashes (CRC32, SHA-1, SHA-256). A current browser with JavaScript enabled is required.

This independent index covers [TwoSpacesSG's **New J2ME Software Archive**](https://archive.org/details/96x65pixels_j2me) as well as its upstream sources that are listed in the archive's description, cf. [`SOURCES.MD`](SOURCES.md). For an alternative visual exploration of the archive refer to [this website](https://f.nnproject.cc/jarchive/).

## Downloads, third-party content, and licensing

This project is independently developed and is not affiliated with or endorsed by TwoSpacesSG, the archive contributors, or the Internet Archive. An optional Python downloader retrieves portions of the original archives from the Internet Archive and reconstructs individual JAR files locally on the user's computer.

**This project does not host or bundle the archived JAR files.**

The project's software license applies only to its original code and documentation, except where otherwise noted. It does not grant rights to archived software, archive-derived datasets, or other third-party content. Archived files remain subject to their respective rights holders, and availability through the Internet Archive does not imply that they are freely licensed. Users are responsible for ensuring their downloads and use comply with applicable laws.

## Search features

There are two main search modes:
1. **Text search**

Case-insensitive text search of original filenames, MIDlet names, and vendors, as well as search-within-results refinement and sorting by title or file size. This supports multiple search terms, `"exact phrases"`, `-term` exclusions, as well as metadata operations like `@version=x.x` (see [Search help](../html/search-help.html) for detailed instructions)

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

## Download an individual JAR

Use the direct download links in the search result. However, beware that downloads from large solid-compressed archives can time out or return HTTP 504. Expand "*Direct download not working?*" for an alternative, or follow the instructions in [`DOWNLOADER.md`](DOWNLOADER.md) for setup, all command-line options, caching details, limitations, and troubleshooting.

## Download the complete index

The [**index-v1 release**](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) contains:

| File | Contents |
| --- | --- |
| `jarchive-combined-verified.csv.gz` | Gzip-compressed verified CSV index: filenames, archive paths, file sizes, CRC32, SHA-1, SHA-256, and collection information |
| `jarchive-combined-verified.csv.gz.sha256` | SHA-256 checksum for the compressed CSV |
| `jarchive-combined-verified.summary.json` | Verification summary |

The index covers the 816,215 archived file entries and 620,287 unique file contents described above; **no** JAR files are included. This CSV is the verified base index -- it is **not** the enriched CSV or manifest-details JSONL required by the site builder below.

## Preview the site locally

From a checkout containing `index.html`, `assets/`, and the generated `data/` directory,
- run in the terminal on Linux/macOS: `python3 -m http.server 8000`
- run in Powershell on Windows, `py -3 -m http.server 8000`.
Then open [http://localhost:8000/](http://localhost:8000/) in your browser. The app reads `.json.gz` files and decompresses them in the browser if the server does not decompress them. The Python downloader uses its own published retrieval index by default; running this local web server does not change the downloader's index source.

**Do not open `index.html` directly as a `file://` page:** browsers restrict local `fetch()` requests. Previewing an existing checkout does not require rebuilding its generated index.

## Rebuild the website's search data

Required input files, created by the separate verification and enrichment pipeline:

1. `jarchive-enriched.csv`: verified SHA-1/SHA-256 index with basic MIDlet fields
2. `jarchive-enriched-details.jsonl.gz`: manifest fields and original source locations

These enriched inputs are not included in the base-index release above and are not published by the site package. **Availability note:** This repository snapshot does not include `build_site.py` or the enriched input files. The following is a maintainer rebuild command for an environment where those separate pipeline components are available; it cannot be run using this source checkout alone. If you only want to preview an existing index, use the local-server instructions above instead.

With `index.html`, `assets/`, and a separately obtained `build_site.py` in the current directory, run the following Linux/macOS example, adjusting the input paths as needed:

```bash
python3 build_site.py \
  --input ~/Downloads/jarchive-enriched.csv \
  --details ~/Downloads/jarchive-enriched-details.jsonl.gz \
  --out . \
  --expected-count 816215
```

The builder uses a temporary SQLite database and writes to a staging directory. It replaces `data/` only after it has successfully generated and checked the new output. On successful completion it prints total byte size and file count, and writes `data/build-summary.json`. The default `--max-original-paths 2` publishes the first two historical original paths per manifest; the total available path count is retained. Use `--max-original-paths 0` to omit original paths from the website or `-1` to publish all paths (larger output and potential personal information in historical paths). The complete original metadata remains untouched outside the website. This command rebuilds the website's `data/` index. After rebuilding the main index, regenerate its separate folder-browsing data with `python3 tools/build_folder_groups.py --repo .`. The downloader's `retrieval/v1/` index is separate; its generation is not covered by these instructions.

## Files and data design

The browser search index lives under `data/`:

- `data/crc32/`, `data/sha1/`, and `data/sha256/`: compressed lookup shards for exact checksum searches
- `data/details/NNNN.json.gz`: lazily fetched manifest/provenance entries corresponding to the same IDs as `records`
- `data/folders/`: separately generated folder counts and lazily loaded folder-membership shards (run `tools/build_folder_groups.py` after rebuilding the main index)
- `data/names-v2/grams.json.gz`: gram-to-shard bitmap for exact substring search
- `data/names-v2/NNN.json.gz`: sorted searchable labels (filename, MIDlet name, vendor) mapped to unique content IDs
- `data/search-summaries/`: optional compact per-name-shard metadata for faster first-time refinement and sorting (generate with `python3 tools/build_search_summaries.py --repo .`)
- `data/records/NNNN.json.gz`: grouped file contents, CRC32/SHA-1/SHA-256 checksums, archive paths, and summary metadata
- `data/upstream/`: supplementary metadata for downloads from upstream collections
- `data/build-summary.json`: summary statistics from the index build
- `data/manifest.json`: index schema, configuration, and counts

### Faster refinement and sorting (optional supplemental index)

Without `data/search-summaries/`, the first sort or refinement must fetch full
`data/records/` chunks for all text-search matches, even though only title,
size and searchable metadata are needed. Those IDs are scattered across many
record chunks. Build a smaller index aligned with the existing name-search
shards to cut that extra network traffic:

```sh
python3 tools/build_search_summaries.py --repo .
```

Run this **from a checkout containing the complete `data/records/` and
`data/names-v2/` directories**, not from the source-only ZIP. The builder uses
SQLite for bounded memory and writes `data/search-summaries/` atomically. It
does not touch `manifest.json`, the main index, folder groups or download URLs.
Add and deploy the generated `data/search-summaries/` files along with the
updated `assets/app.js`. The browser validates the original manifest hash
before using them and gracefully falls back to the original record-loading
path if they are absent or invalid. Rebuild the supplemental files whenever
the main records or name-index shards are rebuilt.

This optimization targets **name-based text searches**. Hash-only searches
still use the original record-loading path when refined or sorted. The amount
of improvement depends on how many name shards match a query, the browser
cache and the network.

### Folder-index rebuild compatibility

`data/folders/` is a supplemental index and must be rebuilt after every change to `data/records/`. The folder index's v2 manifest contains a SHA-256 fingerprint of the complete ordered, uncompressed JSON record data (including archive paths and display metadata), in addition to the original main-manifest digest. Reordering records or changing their sources is detected even if the main `data/manifest.json` stays unchanged. The browser verifies visible folder members against the live records before displaying links; stale or old-schema folder data is disabled rather than presenting potentially wrong associations.

From a checkout with the complete `data/` directory (the second command reads all record shards, i.e., it is separate from the lightweight `tests/check_index.py` check):

```sh
python3 tools/build_folder_groups.py --repo .
python3 tools/check_folder_index.py --repo . --require-folders
```

## Exhaustive index-integrity validation (optional)

`tests/check_index.py` is a fast pre-deployment smoke check: it samples a few
compressed assets and verifies filenames/counts. Before publishing a **major
rebuild of `data/`**, you can additionally validate the *entire* generated
search index with:

```sh
python3 tools/check_full_index.py --repo .
```

This Python-standard-library script reads **every** record and manifest-detail
shard, all CRC32/SHA-1/SHA-256 lookup buckets, every searchable name entry,
and the full 2-/3-gram map. It checks record IDs, checksums, original source
and metadata shapes, unique-content/collection counts, hash-to-record mappings
(including CRC32 collisions), name-label-to-record consistency, and exact
gram-to-name-shard bitmaps. It exits nonzero with the first detected problem.

The validator is deliberately **not** part of the routine Pages deployment
workflow. It is read-only, but decompressing the full index and building
on-disk SQLite expectations can be expensive. It uses system temporary disk
space, not the `data/` directory. To place temporary files on a larger disk:

```sh
python3 tools/check_full_index.py --repo . --temp-dir /path/to/existing/temp-directory
```

The source-only ZIP cannot run this validation because it excludes `data/`.
The command does not rehash the original JAR files or validate download URLs;
optional `data/folders/` compatibility is checked by
`tools/check_folder_index.py`, and other supplemental indexes are outside
this core-index check. See [the testing guide](../tests/README.md).

## Optional metadata search operators

After a normal search word or quoted phrase of **at least two characters**, use
case-insensitive, exact-match `@` filters in Text search:

```text
sonic @version=1.0.0
sonic @midp=2.0 @cldc=1.1
sonic @vendor="Gameloft Studios"
sonic @size>100KB @size<1MiB
sonic @version=?
```

Supported fields: `version`, `vendor`, `midp`, `cldc` (only `=`), and `size`
(`=`, `<`, `>`). The metadata values can be unknown; `?` explicitly
matches an absent **text** field. The MIDP and CLDC operators accept either
`2.0` or `MIDP-2.0` / `CLDC-2.0` forms. Size uses bytes (`B`), decimal
`KB`/`MB` (1,000-based), or binary `KiB`/`MiB` (1,024-based). Spaces inside
values must be quoted, e.g. `@vendor="Some Studio"`. Operators can be combined
and also work in **Search within results**; all conditions must match.

An entire quoted operator, such as `"@version=1.0.0"`, is treated as ordinary
literal text. An unquoted word beginning with `@` reserves operator syntax;
unknown/malformed operators are rejected rather than ignored. Plain queries,
normal quoted phrases, and negative words retain their existing meaning.
Operator-only main searches are intentionally disallowed to avoid a complete
index scan. Filters use existing search summaries, falling back to records on
older deployments; **no index rebuild is required**. An operator filter
uses authoritative full record metadata, which may require additional downloads
compared with ordinary name searches. Archive collection
(Lite/Full) is not yet an operator, because the compact summaries do not store
collection membership.

## Known limitations

- Public metadata includes at most the configured number of historical original-source paths per manifest. Full original paths and untruncated manifest details remain in the original source infofiles and enrichment output

## Future work

Planned and possible improvements are tracked in [`FUTURE_WORK.md`](FUTURE_WORK.md). Please submit further ideas and any problems via [the "Issues" tab](https://github.com/toca-1/new-j2me-software-archive-search/issues).

## Usage of AI

Parts of this project were developed with substantial assistance from ChatGPT. Much of the code was not reviewed by me line by line. I built and tested the project's indexing, search, and download workflows, including manual website and downloader tests on Linux and Windows. These tests do not guarantee that every file, browser, or system configuration will work.
