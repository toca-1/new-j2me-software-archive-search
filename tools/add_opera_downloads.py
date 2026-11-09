#!/usr/bin/env python3
"""Add exact-hash Opera Mini upstream download links to the static J2ME index.

Reads opera_mini_matches.csv produced by scan_opera_upstream.py. Patches the
existing app.js and site.css in place and generates separate compressed
SHA-256 lookup shards. Does not rebuild or modify the main search index.

Python 3.9+, standard library only.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

BASE_URL = "https://archive.org/download/opera-mini-j2me-archive/opera-mini-j2me.zip/"
SOURCE = {"key": "opera-mini", "label": "Opera Mini archive", "base_url": BASE_URL}
HEX = "0123456789abcdef"
SHA256 = re.compile(r"[0-9a-f]{64}\Z")

APP_CACHE_MARKER = "const recordsCache = new Map(), detailsCache = new Map(), hashesCache = new Map(), namesCache = new Map();"
APP_RENDER_MARKER = "function renderResult(id, record) {"
APP_INSERT_MARKER = "  card.append(list, fallbackDownloadAction(sha256));"
APP_FEATURE_MARKER = "// BEGIN upstream direct download sources (v1)"
CSS_FEATURE_MARKER = "/* BEGIN upstream direct download sources (v1) */"

APP_CACHE_INSERT = """
const upstreamShardCache = new Map();
let upstreamSourcesPromise = null;
"""

APP_FUNCTIONS_INSERT = """// BEGIN upstream direct download sources (v1)
// Lookups are isolated from the main search index. Only shards required for
// displayed results are fetched; missing matches do not alter search results.
async function upstreamSourceCatalog() {
  if (!upstreamSourcesPromise) {
    upstreamSourcesPromise = readJson('upstream/sources.json').catch(error => {
      upstreamSourcesPromise = null;
      throw error;
    });
  }
  return upstreamSourcesPromise;
}
function upstreamMemberUrl(base, path) {
  // Archive.org ZIP member URLs keep '/' between path components. Encode all
  // reserved characters within components, including '#' and '?'.
  const encoded = path.split('/').map(segment =>
    encodeURIComponent(segment).replace(/[!'()*]/g,
      ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return base + encoded;
}
async function upstreamMatchesFor(sha256) {
  const catalog = await upstreamSourceCatalog();
  if (catalog.version !== 1 || !Array.isArray(catalog.sources))
    throw new Error('Unsupported upstream source catalog');
  const bucket = await memoized(upstreamShardCache, sha256[0],
    () => readGzipJson(`upstream/${sha256[0]}.json.gz`), 16);
  return (bucket[sha256] || []).map(([sourceIndex, memberPath]) => {
    const source = catalog.sources[sourceIndex];
    if (!source || typeof memberPath !== 'string') return null;
    return {label: source.label, path: memberPath,
      url: upstreamMemberUrl(source.base_url, memberPath)};
  }).filter(Boolean);
}
async function appendUpstreamDownloads(sha256, list) {
  try {
    const matches = await upstreamMatchesFor(sha256);
    if (!list.isConnected) return; // Search results may have been replaced.
    for (const match of matches) {
      const section = elem('div', undefined, 'source source-upstream');
      const top = elem('div', undefined, 'source-line source-head');
      top.append(elem('span', `Upstream: ${match.label}`, 'pill'),
        elem('span', 'Exact SHA-256 match', 'small'));
      const path = elem('div', undefined, 'path');
      const slash = match.path.lastIndexOf('/');
      if (slash >= 0) path.append(document.createTextNode(match.path.slice(0, slash + 1)));
      path.append(elem('strong', match.path.slice(slash + 1), 'path-filename'));
      const actions = elem('div', undefined, 'source-line');
      const link = elem('a', 'Alternative direct download (Internet Archive)', 'jar-download-link');
      link.href = match.url;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      actions.append(link);
      section.append(top, path, actions);
      list.append(section);
    }
  } catch (error) {
    // If an optional upstream shard is temporarily unavailable, the main
    // JARchive links and the terminal downloader must still work normally.
    console.warn('Optional upstream download links unavailable:', error);
  }
}
// END upstream direct download sources (v1)

"""

CSS_INSERT = """
/* BEGIN upstream direct download sources (v1) */
.source-upstream { border: 1px solid #40565b; }
.source-upstream .pill { background: #293940; color: #d3e3e7; }
.source-upstream .small { font-size: 12px; }
/* END upstream direct download sources (v1) */
"""

DOC = """# Additional upstream download links

The site can show exact-match download links to upstream Internet Archive ZIP
members, alongside the original New J2ME Software Archive links. The initial
source is [Opera Mini](https://archive.org/details/opera-mini-j2me-archive).

## Opera Mini mapping

- The Opera Mini ZIP (`opera-mini-j2me.zip`) was scanned without unpacking JARs.
- `scan_opera_upstream.py` produced `opera_mini_matches.csv` by comparing every
  member's SHA-256 to the verified New archive index.
- This analysis found **6,932 JAR entries, 6,859 unique SHA-256 values**, all of
  which matched an existing indexed file. Duplicate ZIP members with the same
  SHA-256 are represented by one selected path in the site mapping.
- A sample ZIP-member URL was downloaded and the JAR SHA-256 was verified.
  This is not a guarantee of continued availability for every member link.

The generated site data is under `data/upstream/`. `sources.json` describes
upstream archive bases. The 16 `.json.gz` shards map SHA-256 hashes to source
indices and member paths, loaded only for displayed search results. Nothing is
added to the main search records, and the JAR files are *not* hosted here.

To regenerate after rescanning the ZIP, run the patch/generator script with its
`--matches` parameter from the repository root. The source CSV is deliberately
not committed (the repository's `.gitignore` excludes CSV files).

The separate optional terminal downloader is still available if browser links
return a timeout or HTTP 504. Other upstream collections can be added later,
with separate hash comparisons and ZIP-member URL tests.
"""


def compact(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def load_matches(path: Path) -> tuple[dict[str, str], int]:
    matches: dict[str, set[str]] = {}
    row_count = 0
    sizes: dict[str, int] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {"sha256", "zip_member", "size_bytes", "member_url"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"Matches CSV must contain {', '.join(sorted(required))}")
        for line, row in enumerate(reader, 2):
            digest = (row["sha256"] or "").strip().lower()
            member = row["zip_member"] or ""
            if not SHA256.fullmatch(digest):
                raise ValueError(f"CSV line {line}: invalid SHA-256")
            if (not member or member.startswith("/") or "\\" in member or
                    any(component in (".", "..", "") for component in member.split("/")) or
                    not member.lower().endswith(".jar") or
                    any(ord(ch) < 32 for ch in member)):
                raise ValueError(f"CSV line {line}: unsafe ZIP member path {member!r}")
            expected_url = BASE_URL + quote(member, safe="/")
            if row["member_url"] != expected_url:
                raise ValueError(f"CSV line {line}: unexpected member URL (source/path mismatch)")
            try:
                byte_size = int(row["size_bytes"])
            except (ValueError, TypeError) as exc:
                raise ValueError(f"CSV line {line}: invalid size") from exc
            if byte_size < 0 or (digest in sizes and sizes[digest] != byte_size):
                raise ValueError(f"CSV line {line}: inconsistent size for SHA-256 {digest}")
            sizes[digest] = byte_size
            matches.setdefault(digest, set()).add(member)
            row_count += 1
    if not matches:
        raise ValueError("The matches CSV is empty")
    # If two locations contain identical bytes, one download link suffices.
    # The shortest URL is generally easiest to read; tie-break consistently.
    selected = {sha: min(paths, key=lambda path: (len(path), path))
                for sha, paths in matches.items()}
    return selected, row_count


def replace_once(text: str, needle: str, replacement: str, description: str) -> str:
    if text.count(needle) != 1:
        raise ValueError(f"Expected one {description} anchor in app.js; found {text.count(needle)}. "
                         "Your local version may differ; no files have been changed.")
    return text.replace(needle, replacement, 1)


def update_app(content: str) -> str:
    if APP_FEATURE_MARKER in content:
        if "appendUpstreamDownloads(sha256, list);" not in content:
            raise ValueError("Found an incomplete pre-existing upstream patch in app.js")
        return content  # Regenerate data without applying the same patch twice.
    content = replace_once(content, APP_CACHE_MARKER,
        APP_CACHE_MARKER + "\n" + APP_CACHE_INSERT.rstrip("\n"), "cache")
    content = replace_once(content, APP_RENDER_MARKER,
        APP_FUNCTIONS_INSERT + APP_RENDER_MARKER, "renderResult")
    content = replace_once(content, APP_INSERT_MARKER,
        "  appendUpstreamDownloads(sha256, list);\n" + APP_INSERT_MARKER, "result download actions")
    return content


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd(),
                        help="Cloned site repository (default: current directory)")
    parser.add_argument("--matches", type=Path, required=True,
                        help="Path to opera_mini_matches.csv")
    parser.add_argument("--expected-unique", type=int, default=6859,
                        help="Guard against generating incomplete mapping (default: 6859)")
    args = parser.parse_args()

    repo = args.repo.expanduser().resolve(strict=True)
    path = args.matches.expanduser().resolve(strict=True)
    app_path, css_path = repo / "assets/app.js", repo / "assets/site.css"
    if not app_path.is_file() or not css_path.is_file() or not (repo / "data/manifest.json").is_file():
        parser.error("--repo must point to your cloned website repository with data/manifest.json")

    mappings, rows = load_matches(path)
    if args.expected_unique and len(mappings) != args.expected_unique:
        parser.error(f"Expected {args.expected_unique:,} unique matches but found {len(mappings):,}; "
                     "verify the CSV or specify --expected-unique intentionally")
    print(f"Read {rows:,} CSV rows; {len(mappings):,} unique matching SHA-256 values.")

    # Validate source and patch anchors BEFORE writing any files.
    app_old = app_path.read_text(encoding="utf-8")
    css_old = css_path.read_text(encoding="utf-8")
    app_new = update_app(app_old)
    css_new = css_old if CSS_FEATURE_MARKER in css_old else css_old.rstrip() + "\n" + CSS_INSERT
    target = repo / "data/upstream"
    if target.exists():
        catalog_path = target / "sources.json"
        try:
            existing = json.loads(catalog_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"Cannot safely replace existing {target}: unknown contents") from exc
        if existing != {"version": 1, "sources": [SOURCE]}:
            raise ValueError(f"Refusing to overwrite {target}: a different upstream catalog exists")

    grouped: dict[str, dict[str, list[list[object]]]] = {c: {} for c in HEX}
    for digest, member in sorted(mappings.items()):
        grouped[digest[0]][digest] = [[0, member]]
    parent = repo / "data"
    # Write the data tree completely before replacing the existing one.
    with tempfile.TemporaryDirectory(prefix=".upstream-staging-", dir=parent) as directory:
        stage = Path(directory) / "upstream"
        stage.mkdir()
        (stage / "sources.json").write_bytes(compact({"version": 1, "sources": [SOURCE]}) + b"\n")
        for prefix, values in grouped.items():
            (stage / f"{prefix}.json.gz").write_bytes(gzip.compress(compact(values), compresslevel=9, mtime=0))
        if target.exists():
            shutil.rmtree(target)
        stage.rename(target)
    if app_new != app_old:
        app_path.write_text(app_new, encoding="utf-8")
    if css_new != css_old:
        css_path.write_text(css_new, encoding="utf-8")
    doc_path = repo / "UPSTREAM_DOWNLOADS.md"
    if not doc_path.exists():
        doc_path.write_text(DOC, encoding="utf-8")

    total = sum(p.stat().st_size for p in target.iterdir() if p.is_file())
    print(f"Generated data/upstream/ with 16 compressed hash buckets + source catalog ({total:,} bytes).")
    print("Updated assets/app.js and assets/site.css (idempotent on subsequent runs).")
    print("Wrote UPSTREAM_DOWNLOADS.md if it did not already exist.")
    print("No JAR files were copied; the existing search data was not rebuilt.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
