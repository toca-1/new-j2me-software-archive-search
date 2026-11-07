# New J2ME Software Archive — Search (v4)

Independent searchable index for [TwoSpacesSG's **New J2ME Software Archive**](https://archive.org/details/96x65pixels_j2me), covering **JARchive v11** and **JARchiveLite v11**. This project is not affiliated with or maintained by the archive's creators or Internet Archive.

## Coverage and verification

The input index was independently computed from the extracted archive file bytes, with the single Linux-overlong file streamed directly from the source 7z. SHA-1, SHA-256, CRC32 and original file sizes were verified against available archival metadata. The verified master index contains **816,215** file entries, representing **620,287** distinct SHA-256 contents. Among these, **195,928** contents appear in both collections; **2,256** only in Lite; **422,103** only in Full.

All 816,215 entries were subsequently matched against the collections' supplied infofiles metadata. The provenance source paths identify historical origins; they are not guaranteed downloadable URLs.

## Search features

- Substring search of original **filename**, **MIDlet-Name**, or **MIDlet-Vendor**; no account or server-side search required.
- Exact lookup of verified **SHA-1** or **SHA-256**.
- Deduplicated file content, with both Full and Lite archive paths and CRC32 values where applicable.
- MIDlet name, vendor, version, CLDC and MIDP shown in each result.
- A compact display of scalar manifest attributes (individual values capped at 4,000 characters) and a configurable number of source locations, fetched only when a result is expanded.
- Per-JAR Internet Archive links. These may be slow or intermittently return HTTP 504 because Archive.org handles archive member extraction.

The query-to-shard index avoids fetching the complete filename catalog for most searches. Very common or short search terms may still need many shards. The site uses standard browser gzip decompression, so a modern browser is required.

## Rebuild the site locally

Required input files, created by the separate verification and enrichment pipeline:

1. `jarchive-enriched.csv` — verified SHA-1/SHA-256 index with basic MIDlet fields.
2. `jarchive-enriched-details.jsonl.gz` — manifest fields and original source locations.

With the supplied `index.html`, `assets/` and `build_site.py` in this directory, run:

```bash
python3 build_site.py \
  --input ~/Downloads/jarchive-enriched.csv \
  --details ~/Downloads/jarchive-enriched-details.jsonl.gz \
  --out . \
  --expected-count 816215
```

Python 3's standard library is sufficient. Building the site does **not** read the original 7z files or rehash JARs.

The builder uses a temporary SQLite database and writes to a staging directory. It replaces `data/` only after it has successfully generated and checked the new output. On successful completion it prints total byte size and file count, and writes `data/build-summary.json`.

The default `--max-original-paths 2` publishes the first two historical original paths per manifest; the total available path count is retained. Use `--max-original-paths 0` to omit original paths from the website or `-1` to publish all paths (larger output and potential personal information in historical paths). The complete original metadata remains untouched outside the website.

### Test locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/ . The app reads `.json.gz` blobs and decompresses them in the browser if the server does not decompress them. **Do not open `index.html` directly as a `file://` page**, because browsers restrict local `fetch()`.

## Files and data design

- `data/manifest.json` — schema version and counts.
- `data/names/grams.json.gz` — gram-to-shard bitmap for exact substring search.
- `data/names/NNN.json.gz` — sorted searchable labels (filename, MIDlet name, vendor) mapped to unique content IDs.
- `data/records/NNNN.json.gz` — grouped file contents, both checksums, original archive paths and summary metadata.
- `data/sha1/X.json.gz` and `data/sha256/X.json.gz` — one compressed lookup bucket per leading hexadecimal digit.
- `data/details/NNNN.json.gz` — lazily fetched manifest/provenance entries corresponding to the same IDs as `records`.

The large source CSV and details JSONL are **not published** by this site package. If releasing those complete sources, use a separately documented release/archive and review provenance paths first.

## Deployment

The generated `data/` folder plus `index.html`, `assets/`, `.nojekyll`, `build_site.py` and `README.md` can be deployed as static files. Keep the repository's `.git` directory when replacing a previous site. **Do not mix v3 `data/` with v4 JavaScript.** See [UPGRADE.txt](UPGRADE.txt) for exact steps.

GitHub Pages documents a [1 GB published-site limit and a 10-minute deployment timeout](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits). Compression and fewer files reduce the publishing load, but cannot guarantee that a stuck GitHub-side deployment will recover.

## Known limitations

- A manifest title can match several builds; this is not automatic fuzzy game/version grouping.
- Some manifest fields and old source paths may be missing or misleading in the original archival metadata. Identifiers and checksums come from verified JAR bytes, not from manifest titles.
- The public metadata includes at most the configured count of original source paths. Full original paths and untruncated manifest details remain in the original source infofiles and your original enrichment output.
- An Internet Archive 504 timeout is outside this website's control.

## Attribution

Archive source: [TwoSpacesSG / Internet Archive](https://archive.org/details/96x65pixels_j2me). The search tool and indexing workflow are independently produced, not endorsed by the source archive. Choose and add a repository license separately after reviewing any reused code and dataset rights.
