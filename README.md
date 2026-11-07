# Searching the New J2ME Software Archive

[This website](https://toca-1.github.io/new-j2me-software-archive-search/) is an independent searchable index for [TwoSpacesSG's **New J2ME Software Archive**](https://archive.org/details/96x65pixels_j2me), covering JARchive v11 and JARchiveLite v11. This project is not affiliated with or maintained by the archive's creators or Internet Archive.

## Search features

- Substring search of original filename, MIDlet-Name, or MIDlet-Vendor
- Exact lookup of verified SHA-1 or SHA-256
- Deduplicated file content, with both Full and Lite archive paths and CRC32 values where applicable
- MIDlet name, vendor, version, CLDC, MIDP, and -- most importantly -- per-JAR download links from the Internet Archive shown in each result

The site uses standard browser gzip decompression, so a modern browser is required.

## Rebuild the site locally

Required input files, created by the separate verification and enrichment pipeline:

1. `jarchive-enriched.csv` — verified SHA-1/SHA-256 index with basic MIDlet fields
2. `jarchive-enriched-details.jsonl.gz` — manifest fields and original source locations

With the supplied `index.html`, `assets/` and `build_site.py` in this directory, run:

```bash
python3 build_site.py \
  --input ~/Downloads/jarchive-enriched.csv \
  --details ~/Downloads/jarchive-enriched-details.jsonl.gz \
  --out . \
  --expected-count 816215
```

The builder uses a temporary SQLite database and writes to a staging directory. It replaces `data/` only after it has successfully generated and checked the new output. On successful completion it prints total byte size and file count, and writes `data/build-summary.json`. The default `--max-original-paths 2` publishes the first two historical original paths per manifest; the total available path count is retained. Use `--max-original-paths 0` to omit original paths from the website or `-1` to publish all paths (larger output and potential personal information in historical paths). The complete original metadata remains untouched outside the website.

### Test locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/ . The app reads `.json.gz` blobs and decompresses them in the browser if the server does not decompress them. **Do not open `index.html` directly as a `file://` page**, because browsers restrict local `fetch()`.

## Files and data design

- `data/manifest.json` — schema version and counts
- `data/names/grams.json.gz` — gram-to-shard bitmap for exact substring search
- `data/names/NNN.json.gz` — sorted searchable labels (filename, MIDlet name, vendor) mapped to unique content IDs
- `data/records/NNNN.json.gz` — grouped file contents, both checksums, original archive paths and summary metadata
- `data/sha1/X.json.gz` and `data/sha256/X.json.gz` — one compressed lookup bucket per leading hexadecimal digit
- `data/details/NNNN.json.gz` — lazily fetched manifest/provenance entries corresponding to the same IDs as `records`

The large source CSV and details JSONL are **not published** by this site package.

## Known limitations

- A manifest title can match several builds; this is not automatic fuzzy game/version grouping
- Some manifest fields and old source paths may be missing or misleading in the original archival metadata
- The public metadata includes at most the configured count of original source paths. Full original paths and untruncated manifest details remain in the original source infofiles and your original enrichment output

## Attribution

Archive source: [TwoSpacesSG / Internet Archive](https://archive.org/details/96x65pixels_j2me). The search tool and indexing workflow are independently produced, not endorsed by the source archive. Choose and add a repository license separately after reviewing any reused code and dataset rights.

## Usage of AI

Parts of this project were developed with substantial assistance from ChatGPT. Much of the code was not reviewed by me line by line. I did, however, build the project from scratch and test the complete workflow, verifying that everything works as intended in the setup described here.
