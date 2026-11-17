# New J2ME Software Archive Search

[**Search the archive**](https://toca-1.github.io/new-j2me-software-archive-search/) · [Search help](../html/search-help.html) · [Downloader guide](DOWNLOADER.md) · [Sources](SOURCES.md)

An independent, browser-based index of [TwoSpacesSG's New J2ME Software Archive](https://archive.org/details/96x65pixels_j2me): **816,215 archived entries**, representing **620,287 distinct JAR contents**. A current browser with JavaScript is required. For another way to explore the archive, see [nnproject's JARchive browser](https://f.nnproject.cc/jarchive/).

## Search and downloads

- **Text search:** original filenames, MIDlet titles and vendors; multiple terms, quoted phrases, exclusions, and exact metadata filters such as `sonic @version=1.0` or `game @size>100KB` ([all operators](../html/search-help.html)). Refine and sort results without starting over.
- **Hash search:** automatically identifies a complete CRC32, SHA-1 or SHA-256 value.
- **Results:** MIDlet/version/CLDC/MIDP metadata where available, historical source paths and manifests, folder browsing, and paginated results (5/10/20/50 per page). Export up to 10,000 results to CSV in the current filtered/sorted order.
- **Downloads:** direct links to Internet Archive files and available mirrors. When direct downloads time out (large solid-compressed archives can return HTTP 504), use the [Python downloader](DOWNLOADER.md) for an alternative. The downloadable script remains at [`jarchive_download.py`](../jarchive_download.py).

This site **does not host or bundle JAR files**. It is not affiliated with or endorsed by TwoSpacesSG, the archive's contributors or the Internet Archive. The project's license covers its original code/documentation only, not the archived software or other third-party data. Individual files remain subject to their rights holders; access does not imply a license to redistribute or use them. See [attribution](ATTRIBUTION.md).

## Obtain the verified base index

The [**index-v1 release**](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) provides `jarchive-combined-verified.csv.gz`, its `.sha256` checksum and a verification summary. The CSV records archive paths, filenames, sizes, CRC32, SHA-1 and SHA-256 values. **It is not the enriched CSV** needed by the site builder, and contains no JAR files.

## Run or rebuild locally

To preview an existing checkout containing the generated `data/` directory, run `python3 -m http.server 8000` (Windows: `py -3 -m http.server 8000`) from the repository root and open <http://localhost:8000/>. Opening `index.html` directly as `file://` will not work because browsers restrict local fetches. A source-only ZIP does not contain the large generated `data/` assets.

For a **single-command candidate rebuild**, see **[REBUILD_ALL.md](REBUILD_ALL.md)**:

```sh
python3 tools/rebuild_all.py \
  --reference-data ./data \
  --archive-dir /path/to/the-four-jarchive-7z-files \
  --out /path/to/new/candidate-directory
```

The command reconstructs enrichment, the core index, folder browsing and search summaries, validates the results and compares them against the published reference. The output must be a **new directory**, not this repository's live `data/`. An existing enriched CSV/JSONL pair can be reused with `--enriched-dir`.

**Reconstruction is reference-backed:** SHA-1/SHA-256 and primary metadata come from the existing validated index; the four archives alone do not support an independent rebuild from JAR bytes. See [reproducibility and the overlong-filename hashing procedure](REPRODUCIBILITY.md). Separately sourced upstream download mappings can be copied, but are not independently regenerated from these archives.

## For contributors

The site's core assets are in `index.html`, `html/` and `assets/`; the published search data is in `data/` (`records/`, `details/`, `names-v2/`, `crc32/`, `sha1/`, `sha256/`), with optional `folders/`, `search-summaries/` and `upstream/` indexes. The downloader also uses `retrieval/v1/`. Python rebuild/validation utilities live in `tools/` and are **not** required in the GitHub Pages deployment. See the [test guide](../tests/README.md), [source coverage](SOURCES.md), and [future work](FUTURE_WORK.md); report problems via [GitHub Issues](https://github.com/toca-1/new-j2me-software-archive-search/issues).

Parts of this project were developed with substantial ChatGPT assistance and were not all reviewed line by line. The indexing, search and downloader workflows were tested, including manual Linux/Windows tests, but this cannot guarantee correct operation for every file, browser or configuration.
