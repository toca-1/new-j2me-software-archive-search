# Unified J2ME Archive Search

Static GitHub Pages index of the [Unified J2ME Archive (September 2019)](https://archive.org/details/j2me-archive-unified-2019-09), built for locating exact JARs and verifying TAS reproduction builds.

**Website:** https://toca-1.github.io/unified-j2me-archive-search/

## What is indexed

536,025 nonempty, regular files from the original archive, with their exact filenames, archive paths, sizes, SHA-1 hashes, solid block IDs and required 7z volumes. There are 63 solid blocks; a representative JAR from each block was successfully recovered using sparse substitute volumes, with a matching SHA-1. This is **block-level sampling**, not individual validation of every one of the 536,025 files.

234,919 symlink entries were excluded because 7-Zip's extraction refused to create them, and a separate 4,894 genuinely zero-byte files were omitted from the searchable index. Names alone do not guarantee working games. Files themselves are **not** redistributed here.

## Build or rebuild the website data

Install Python 3. Copy `j2me-search-index-with-parts.csv` to your machine (do not commit it). From this repository's root:

```bash
python3 build_site.py --input /path/to/j2me-search-index-with-parts.csv --expected-count 536025
```

No external Python packages are needed. This produces `data/` with small record shards, a compressed filename catalog and SHA-1 prefix lookup files. The website is a static HTML/CSS/JavaScript frontend, with no API or account requirements.

Filename search downloads a compressed **names-only** catalog upon first use, then fetches only the requested result record shards. Exact SHA-1 lookup fetches only the relevant 2-hex-prefix shard and result record shard. The full original CSV is not downloaded by visitors.

For local testing, run `python3 -m http.server 8000` from the repository folder and visit http://localhost:8000/. Do not open `index.html` using `file://`, since browser fetches require a web server.

## Recover one file

On Ubuntu/Linux:

```bash
sudo apt install python3 curl 7zip
python3 j2me_fetch.py --parts 001,010,011,043 --path 'dertz.in/dls/01269-3D DOOM-3.jar' --sha1 d2e3d085d25a80515a2527ef499a1025f5cd837e
```

The helper downloads only selected real 7z volumes from the original Archive.org item, unwraps the `.001.zip` first volume, creates *sparse* placeholders with the expected logical volume sizes, extracts the specific file and verifies its SHA-1. A sparse placeholder consumes virtually no physical disk space on a supporting filesystem, but the necessary actual downloaded data still requires storage.

You need the **complete** split-archive metadata volumes (`001` and `043`) plus the real compressed-data volumes for the file's solid block. Missing parts are not independently extractable ZIPs. If a download is unavailable or corrupted, recovery will fail; matching SHA-1 is the ultimate test.

## Publishing on GitHub Pages

Clone this repo, run `build_site.py`, commit the generated `data/` directory and source files, and push `main`. In Settings → Pages, use **Deploy from a branch** → `main` → `/(root)`. The repository's root contains `.nojekyll` so Pages serves static assets without a Jekyll transformation.

## Credits and scope

This is an independently generated index of an existing preservation collection, not an official archive or a mirror of game software. Indexing methodology: original 7-Zip listing → extracted file SHA-1 checksums → rejection of symlink placeholders and empty files → attachment of solid-block/volume ranges → one successful SHA-1 recovery test per solid block.

The helper currently targets Linux and POSIX filesystems. Other platforms may need adjustments for sparse files and 7-Zip command compatibility.
