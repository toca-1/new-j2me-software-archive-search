# New J2ME Software Archive — Search

Independent searchable index for [The “New” J2ME software archive](https://archive.org/details/96x65pixels_j2me) by TwoSpacesSG.

## Coverage

The source is the **verified** `jarchive-combined-verified.csv` containing 816,215 archived file entries (198,184 JARchiveLite v11; 618,031 JARchive v11). After grouping identical SHA-256 values there are **620,287** distinct file contents: 195,928 present in both collections, 2,256 Lite-only, 422,103 Full-only.

All SHA-1 and SHA-256 checksums were calculated from actual contents and compared to available original metadata (Lite DAT SHA-1, Full filename SHA-256, archive CRC32/size). A single filename too long for Linux ext4 was hashed by streaming the file directly from the 7z archive.

## Build the index

Download/unzip this starter to a folder, then run in Ubuntu:

```sh
python3 build_site.py \
  --input ~/Downloads/jarchive-combined-verified.csv \
  --out . \
  --expected-count 816215
```

`data/` is created locally. Commit the website files and generated `data/` to your GitHub Pages repository, selecting **main** / **root** in Settings → Pages. Build does not rehash or extract JAR files. It groups matching contents by SHA-256, keeping *both* original archive paths. The archive source is represented in each result.

The static site uses 1024-entry record chunks, 256 SHA-1 prefix index files, 256 SHA-256 prefix index files, and compressed filename shards. Filename lookup loads compressed filename shards on first use; exact hash lookups retrieve a small prefix index and record chunk. `DecompressionStream('gzip')` is used in modern browsers for filename lookup. Serve through a local HTTP server for testing, rather than opening `index.html` as a local file:

```sh
python3 -m http.server 8000
```

Open http://localhost:8000/ to test.

## Download links and limitations

Each result has a link for the corresponding member of the Internet Archive 7z file using the `archive.org/download/96x65pixels_j2me/<archive>/<member>` pattern. **Verify at least one real link from each collection before announcing single-file downloading.** The Internet Archive archive viewer may be rate-limited or unavailable; archived 7z files are solid archives, so member extraction on the server may have costs or delays. The website does not mirror JAR files or serve malicious code directly.

This is a complete *file-content* index of the two JARchive v11 collections; only ordinary file entries were indexed (not directory rows). Each source path is preserved. Search currently matches original filenames, not all directory path segments or manifest titles. A file-tree explorer and manifest-based title search can be added later.

### Offline source preservation

Keep a backup of `jarchive-combined-verified.csv` and its summary JSON. Host a `.csv.gz` copy in a GitHub Release or Internet Archive item and link to it from the website. Avoid placing a very large raw CSV in normal Git history. Scripts and website source can be licensed separately from archived JAR contents. Cite and credit the original archive author and sources.

## AI Disclaimer

tbd
