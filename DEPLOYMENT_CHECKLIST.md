# Downloader deployment checklist

The `retrieval/v1/` lookup shards have already been published. This checklist covers releasing the standalone downloader and website guide safely, without republishing the 512 existing shards or rebuilding `data/`.

## Already completed (as of 2026-11-08)

- [x] Scan and validate all 36 solid-compressed 7z blocks, including LZMA2 `0x01` resets.
- [x] Reconcile all **816,215** archive entries against the UTF-8-correct verified CSV; no unmatched paths.
- [x] Export SHA-256 lookup for **620,287** unique contents and SHA-1 sidecar lookup shards.
- [x] Push `retrieval/v1/` to `main` at commit `79e3160` and confirm the matching Pages deployment succeeded.
- [x] Confirm `https://toca-1.github.io/new-j2me-software-archive-search/retrieval/v1/manifest.json` returns **HTTP 200**.
- [x] Recover and cryptographically verify freeSnake and Crash Bandicoot against the original archive.

## Files in this deployment bundle

- [ ] Publish **`jarchive_download.py`** at repository root so the user-facing raw download link works.
- [ ] Publish **`DOWNLOADER.md`** at repository root with quick start, every supported option, caching, troubleshooting and safety notes.
- [ ] Publish **`ATTRIBUTION.md`** explaining Python/liblzma, curl, format references and the distinction between reference and reused code.
- [ ] Update **`index.html`**'s existing HTTP 504 notice to include an expandable alternative-download quick start and links to the script and guide.
- [ ] Append minimal styling to **`assets/site.css`**; verify mobile widths, readable code block and keyboard-accessible `<summary>`.
- [ ] Add downloader and attribution links to **`README.md`**.

## Technical release checks (before pushing)

- [ ] `git pull --ff-only` from `main`; ensure current working tree is clean.
- [ ] `python3 -m py_compile jarchive_download.py` and `python3 jarchive_download.py --help` work.
- [ ] Local `--dry-run` with a known SHA-1 and SHA-256; force `--index-url` to exercise GitHub Pages when a local index exists.
- [ ] Test cache reuse with the same command a second time; test `--index-offline --dry-run` after priming the index cache.
- [ ] Test an actual download with a new output path and compare to an existing verified JAR (`sha256sum` / `cmp`).
- [ ] Test recovery from a forced interruption and verify complete chunks are reused; ensure no partial JAR is published.
- [ ] Test a missing/invalid hash, a source without a Lite copy, and an existing output filename.
- [ ] Confirm `curl` and `lzma` requirements on target platforms (at minimum Ubuntu; ideally Windows PowerShell and macOS).
- [ ] `git diff --check` and inspect the complete diff. Do not commit any `.jarchive-cache/`, local `.jar`, 7z, `.sqlite`, or large input CSV files.

## Website / GitHub Pages checks (after pushing)

- [ ] GitHub Pages deployment succeeds for the exact new commit (`gh run list --limit 5 --json headSha,conclusion`).
- [ ] Main website search still works for name, SHA-1, and SHA-256 queries.
- [ ] HTTP 504 notice opens and closes by keyboard and touch, and links to the standalone guide and script.
- [ ] Raw downloader link returns HTTP 200, and `DOWNLOADER.md` / `ATTRIBUTION.md` render in GitHub.
- [ ] Previously published `retrieval/v1/manifest.json`, `sha1/71.json.gz`, and `sha256/42.json.gz` are still available.
- [ ] Run downloader **outside** the folder that contains the local retrieval index, with **no** `--index` flag, to confirm remote lookup is genuinely automatic.

## Before a public announcement

- [ ] Choose and publish an explicit **software license**, after reviewing whether any source has actually been copied from external repositories. Do not claim third-party rights over the archived JARs.
- [ ] Consider pinning an annotated downloader version or GitHub Release, and publish the script's SHA-256 digest for reproducibility.
- [ ] Confirm the current downloader still handles temporary HTTP 500/504 failures gracefully; note clearly that it is **not an independent archive mirror**.
- [ ] Decide on cache retention and disk usage guidance; warn that the downloader does not automatically prune old compressed ranges.
- [ ] Consider adding CI checks for SHA lookup format, LZMA2 `0x01` and `0xE0` restart handling, cache corruption and HTTP Range validation.
- [ ] Consider a future browser-native downloader only after measuring memory, server CORS, user-experience and maintenance costs.
