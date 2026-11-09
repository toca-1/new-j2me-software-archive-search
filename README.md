# New J2ME Software Archive Search

[Search J2ME games, apps, and exact JAR builds](https://toca-1.github.io/new-j2me-software-archive-search/) filename, title, vendor, SHA-1, or SHA-256. This independent index covers JARchive v11 and JARchiveLite v11 from [TwoSpacesSG's **New J2ME Software Archive**](https://archive.org/details/96x65pixels_j2me). A current browser with JavaScript enabled is required.

## Downloads, third-party content, and licensing

This project is independently developed and is not affiliated with or endorsed by TwoSpacesSG, the archive contributors, or the Internet Archive. An optional Python downloader retrieves portions of the original archives from the Internet Archive and reconstructs individual JAR files locally on the user's computer.

**This project does not host or bundle the archived JAR files.**

The project's software license applies only to its original code and documentation, except where otherwise noted. It does not grant rights to archived software, archive-derived datasets, or other third-party content. Archived files remain subject to their respective rights holders, and availability through the Internet Archive does not imply that they are freely licensed. Users are responsible for ensuring their downloads and use comply with applicable laws.

## Search features

- Case-insensitive substring search of original filenames, MIDlet names, and vendors
- Exact lookup by SHA-1 or SHA-256 checksum
- MIDlet name, vendor, version, CLDC, and MIDP information where available
- Direct download links to individual JAR files on the Internet Archive
- Expandable manifest details and historical original-source locations
- Alternative downloader instructions and copyable commands for Windows and Linux/macOS

## Download an individual JAR

Use the **Direct download (Internet Archive)** link in a search result. Downloads from large solid-compressed archives can time out or return HTTP 504. Expand **Direct download not working?** for an alternative, or follow the instructions in [**DOWNLOADER.md**](DOWNLOADER.md) for setup, all command-line options, caching details, limitations, and troubleshooting.

## Download the complete index

The [**index-v1 release**](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) contains:

| File | Contents |
| --- | --- |
| `jarchive-combined-verified.csv.gz` | Gzip-compressed verified CSV index: filenames, archive paths, file sizes, CRC32, SHA-1, SHA-256, and collection information |
| `jarchive-combined-verified.csv.gz.sha256` | SHA-256 checksum for the compressed CSV |
| `jarchive-combined-verified.summary.json` | Verification summary |

The index covers the 816,215 archived file entries and 620,287 unique file contents described above. No JAR files are included. This release CSV is the verified base index. It is **not** the enriched CSV or manifest-details JSONL required by the site builder below.

## Preview the site locally

From a checkout containing `index.html`, `assets/`, and the generated `data/` directory, run:

```bash
python3 -m http.server 8000
```

On Windows, use `py -3 -m http.server 8000` instead. Then open [http://localhost:8000/](http://localhost:8000/) in your browser. The app reads `.json.gz` files and decompresses them in the browser if the server does not decompress them. The Python downloader uses its own published retrieval index by default; running this local web server does not change the downloader's index source.

**Do not open `index.html` directly as a `file://` page:** browsers restrict local `fetch()` requests. Previewing an existing checkout does not require rebuilding its generated index.

## Rebuild the website's search data

Required input files, created by the separate verification and enrichment pipeline:

1. `jarchive-enriched.csv`: verified SHA-1/SHA-256 index with basic MIDlet fields
2. `jarchive-enriched-details.jsonl.gz`: manifest fields and original source locations

These enriched inputs are not included in the base-index release above and are not published by the site package. With `index.html`, `assets/`, and `build_site.py` in the current directory, run the following Linux/macOS example, adjusting the input paths as needed:

```bash
python3 build_site.py \
  --input ~/Downloads/jarchive-enriched.csv \
  --details ~/Downloads/jarchive-enriched-details.jsonl.gz \
  --out . \
  --expected-count 816215
```

The builder uses a temporary SQLite database and writes to a staging directory. It replaces `data/` only after it has successfully generated and checked the new output. On successful completion it prints total byte size and file count, and writes `data/build-summary.json`. The default `--max-original-paths 2` publishes the first two historical original paths per manifest; the total available path count is retained. Use `--max-original-paths 0` to omit original paths from the website or `-1` to publish all paths (larger output and potential personal information in historical paths). The complete original metadata remains untouched outside the website. This command rebuilds the website's `data/` index. The downloader's `retrieval/v1/` index is separate; its generation is not covered by these instructions.

## Files and data design

The browser search index lives under `data/`:

- `data/manifest.json`: schema version and counts
- `data/names/grams.json.gz`: gram-to-shard bitmap for exact substring search
- `data/names/NNN.json.gz`: sorted searchable labels (filename, MIDlet name, vendor) mapped to unique content IDs
- `data/records/NNNN.json.gz`: grouped file contents, both checksums, archive paths, and summary metadata
- `data/sha1/X.json.gz` and `data/sha256/X.json.gz`: one compressed lookup bucket per leading hexadecimal digit
- `data/details/NNNN.json.gz`: lazily fetched manifest/provenance entries corresponding to the same IDs as `records`

The Python downloader uses a separate index under `retrieval/v1/`, with its own manifest and SHA-1/SHA-256 lookup shards.

## Known limitations

- Text search is substring-based; it does not automatically group related games or versions
- Broad text searches may need to fetch and scan multiple index shards. A first search can take longer when the necessary data is not cached
- Some manifest fields and historical source paths may be missing or misleading in the original archival metadata
- Public metadata includes at most the configured number of historical original-source paths per manifest. Full original paths and untruncated manifest details remain in the original source infofiles and enrichment output
- Download availability and speed depend on the Internet Archive and the user's connection

## Future work

Planned and possible improvements are tracked in [**FUTURE_WORK.md**](FUTURE_WORK.md). Please submit further ideas and any problems via the "Issues" tab.

## Usage of AI

Parts of this project were developed with substantial assistance from ChatGPT. Much of the code was not reviewed by me line by line. I built and tested the project's indexing, search, and download workflows, including manual website and downloader tests on Linux and Windows. These tests do not guarantee that every file, browser, or system configuration will work.
