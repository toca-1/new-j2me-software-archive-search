# JAR downloader

Use a python script to recover individual JAR files from the Internet archive using their SHA-1 or SHA-256 checksum.

## Quick start

**Requirements:** Python 3.9 or newer and the `curl` command on your path. No downloaded archives or local index files are needed. For any issues that arise, first check the [Errors and Troubleshooting section](https://github.com/toca-1/new-j2me-software-archive-search/blob/main/DOWNLOADER.md#errors-and-troubleshooting) down below.

1. Download [`jarchive_download.py`](https://toca-1.github.io/new-j2me-software-archive-search/jarchive_download.py).
2. Open the terminal/command line/PowerShell in the same folder where your `jarchive_download.py` sits
3. On the [archive search site](https://toca-1.github.io/new-j2me-software-archive-search/), at the bottom of the box of the game you're interested in you'll see "Copy download command" followed by two buttons: "Windows" and "Linux/macOS". Simply clicking the button corresponding to your operating system copies the command that you need to run in the terminal.

Alternatively:

2. On the [archive search site](https://toca-1.github.io/new-j2me-software-archive-search/), search for the game and copy its SHA-1 or SHA-256.
3. From the folder containing the script, on Linux/macOS run:
   ```bash
   python3 jarchive_download.py YOUR_SHA1_OR_SHA256
   ```
   or on Windows run:
   ```powershell
   py -3 .\jarchive_download.py YOUR_SHA1_OR_SHA256
   ```
   By default the output is `<SHA-256>.jar` in your current working directory. The script never overwrites an existing output file. Pass `--output PATH/FILENAME` to choose the destination or give the downloaded file another name.

## How it works

The script downloads only portions of the original solid-compressed 7z archive over HTTP Range, starts decompression at an indexed independent LZMA2 restart, and saves the JAR only if the content matches the verified index. More specifically:

- It fetches the small `retrieval/v1/manifest.json` and the required gzip-compressed SHA lookup shard(s) from GitHub Pages
- It selects the archive copy requiring the least decompression. If a hash has multiple sources, it can try others upon failure
- It locates the actual Internet Archive storage servers from the item's metadata, and uses bounded HTTP byte-range requests
- Successful complete HTTP ranges are cached under `.jarchive-cache/`; rerunning the same command resumes from those cached ranges instead of starting again
- The displayed percentage is progress on the decoding. A compressed transfer upper bound is printed, but the actual transfer may be much smaller
- Before saving, the recovered JAR must pass its expected file size, CRC32, SHA and ZIP internal integrity checks

### Examples

Preview which archive source would be used:

```bash
python3 jarchive_download.py YOUR_HASH --dry-run
```

Use a custom filename, or force the archive source:

```bash
python3 jarchive_download.py YOUR_HASH --output my-game.jar
python3 jarchive_download.py YOUR_HASH --source full
python3 jarchive_download.py YOUR_HASH --source lite
```

Allow more time for slow or inconsistent connections; after Ctrl+C or a temporary failure, run the exact same command again to resume where the download left off:

```bash
python3 jarchive_download.py YOUR_HASH --request-timeout 90 --stall-limit 240
```

If you have already downloaded index files you can use them via:

```bash
python3 jarchive_download.py YOUR_HASH --index-offline
```

Use a complete local retrieval index or a custom index server:

```bash
python3 jarchive_download.py YOUR_HASH --index /PATH/TO/jarchive-retrieval-v1
python3 jarchive_download.py YOUR_HASH --index-url https://EXAMPLE.ORG/RETRIEVAL
```

## Full command-line options

Run `python3 jarchive_download.py --help` for the options supported by your exact script version.

| Option | Default | Meaning |
| --- | --- | --- |
| `hash` | **required** | SHA-1 (40 hex digits) or SHA-256 (64 hex digits) |
| `--output PATH` | `<SHA-256>.jar` | Destination; does not overwrite existing files |
| `--dry-run` | off | Show sources without downloading JAR ranges; remote index may still be fetched |
| `--source {auto,lite,full}` | `auto` | Choose an archive copy; auto ranks by bytes to decompress and tries fallbacks |
| `--index PATH` | automatic | Use a local index directory; incompatible with `--index-url` |
| `--index-url URL` | project pages URL | Explicit remote index location, even when a local index exists |
| `--index-offline` | off | No remote index requests; previously cached index resources required |
| `--index-fetch-timeout SECONDS` | `20` | Hard timeout for each remote index request |
| `--cache-dir PATH` | `.jarchive-cache` | Save reusable index resources and validated complete compressed ranges |
| `--no-cache` | off | Disable archive range caching; does not disable remote index caching |
| `--base-url URL` | IA archive download base | Use another archive download base; IA storage discovery only applies to the default URL |
| `--no-direct` | off | Skip IA storage-node discovery and use the configured base URL only |
| `--metadata-timeout SECONDS` | `7` | Timeout for Internet Archive metadata discovery |
| `--request-timeout SECONDS` | `45` | Hard limit for one byte-range request |
| `--connect-timeout SECONDS` | `5` | Connection timeout for byte-range requests |
| `--stall-limit SECONDS` | `120` | Allow this long without a completed new range before failing |
| `--route-passes N` | `2` | Maximum passes across available download routes per range (1–5) |
| `--time-limit SECONDS` | `0` (off) | Optional *total* transfer time limit; disabled by default |
| `--chunk-kib N` | `1024` | Compressed bytes per request, in KiB (maximum 4096) |
| `--max-download-mib N` | `512` | Hard cap on compressed bytes processed per source, including cached bytes |
| `--max-jar-mib N` | `128` | Maximum uncompressed JAR size |

When choosing `--chunk-kib`, smaller chunks can reduce wasted data on a failed request, but increase request overhead; **keep the same value between resumed attempts** to maximize cache reuse.

## Errors and troubleshooting

- **Python not installed** / **Missing `lzma` module** / **Missing curl** or : Use a Python build with `lzma`/liblzma support. On Linux/macOS, run `sudo apt update && sudo apt install -y python3 curl`, on Windows run `winget install --id Python.Python.3.14 -e`, and on macOS run `brew install python` (if Homebrew is missing, install it first: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`)
- **HTTP 500 / 504 / range timeout:** Internet Archive may be overloaded. The downloader tries known direct storage servers and the normal route
- **`No successful HTTP range within the stall/time limit`:** Try `--request-timeout 90 --stall-limit 240` if the connection is slow but usable
- **`Output exists (will not overwrite)`:** Use a new `--output` filename or explicitly remove/rename the existing file after inspecting it
- **`SHA-1 not found`, `SHA-256 not found`:** Verify you copied the full 40- or 64-digit hash of an indexed file, not its CRC32 or an unrelated hash
- **Index HTTP 404:** Verify [retrieval/v1/manifest.json](https://toca-1.github.io/new-j2me-software-archive-search/retrieval/v1/manifest.json) loads
- **Missing cached index in `--index-offline` mode:** Perform the lookup once while online (or use `--index PATH`)
- **Damaged or stale cached data:** The script automatically rejects ranges whose local checksum does not match. If in doubt, retry with `--no-cache` or delete `.jarchive-cache/` (this discards resumable progress)
- **Download cap exceeded:** Review the planned compressed upper bound and only increase `--max-download-mib` if you are comfortable with the additional data transfer

## Privacy, trust and rights

The downloader sends archive range requests to the Internet Archive, and index lookups to the public project's GitHub Pages site. These services can see the requests and IP address; the requested hash prefix is part of the index shard URL. Index metadata and individual archive JARs come from third-party resources. Integrity checks confirm the file matches the published hash; they cannot make untrusted game software safe to execute. Use an appropriate sandbox for unknown software. Most importantly, no original JARs are hosted in this repository. Rights to archived software remain with their respective rights holders.

This is an independently built community tool, not an official Internet Archive feature. See [ATTRIBUTION.md](ATTRIBUTION.md) for technical references and attribution notes.
