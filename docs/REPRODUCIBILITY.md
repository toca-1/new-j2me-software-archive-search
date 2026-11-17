# Reproducing and checking the archive index

This page describes the **documented, currently testable** parts of the New
J2ME Software Archive Search pipeline: inspecting archive members, hashing JAR
bytes, linking metadata to verified content hashes, rebuilding *available*
website indexes, and validating the result. The historical **v4** site builder
is recoverable from Git history, but the enrichment inputs, enrichment pipeline
and a confirmed builder for the **current** search-index schema are not supplied
in this source checkout. This is not a claim that the complete original
ingest-to-current-site process can be rerun from the repository alone.

For archive provenance and upstream coverage see [SOURCES.md](SOURCES.md); for
the browser index layout and builder notes see [README.md](README.md).

## 1. Inputs and reproducibility boundary

| Input or component | Source / availability | What it enables |
| --- | --- | --- |
| Original Lite/Full 7z archives | Third-party files from [the Internet Archive collection](https://archive.org/details/96x65pixels_j2me); not included here | Independent hashing of the actual archived JAR bytes |
| `jarchive-combined-verified.csv.gz`, `.sha256`, summary JSON | Published [index-v1 release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1); not in the source-only ZIP | Checking the published base inventory and its compressed-file checksum |
| `jarchive-enriched.csv`, `jarchive-enriched-details.jsonl.gz` | Separate enrichment pipeline, **not published in this repository or the index-v1 release** | Inputs required by the historical site builder |
| Historical `build_site.py` (v4) | Removed in commit `97a3b2f`; **recoverable from Git history**, but absent from the current working tree | Explains the original v4 main-index build; **not a drop-in builder for today's index** |
| Generated `data/` tree | Present in a complete deployed checkout; not included in the source-only ZIP | Search, full index validation and regeneration of supplemental indexes |
| `tools/build_folder_groups.py`, `tools/build_search_summaries.py` | Included here | Regenerate supplemental indexes from the existing main index |
| Downloader `retrieval/v1/` generation and upstream mapping generation | Separate, undocumented build processes | **Not** reproduced by the commands on this page |

The published base inventory describes **816,215 file locations/entries and
620,287 unique contents**. Those are different units: different archive paths
or copies can contain byte-identical JARs. The original filenames, member
paths, archive collection (Lite/Full), sizes, CRC32 and SHA values should not
be collapsed into one filename per content hash. The website uses one record
per unique SHA-256, retaining multiple source locations.

## 2. Preserve the archive inputs and verify the base index

Keep the downloaded original archives unchanged, record their exact source URL,
filename, retrieval date, and SHA-256, and work on a separate copy or stream.
For any downloaded original archive:

```sh
sha256sum /path/to/original-archive.7z
```

Place the three release files listed above in one directory and verify the
compressed CSV before processing its contents:

```sh
cd /path/to/downloaded/index-v1-files
sha256sum -c jarchive-combined-verified.csv.gz.sha256
gzip -t jarchive-combined-verified.csv.gz
python3 - <<'PY'
import csv, gzip
with gzip.open('jarchive-combined-verified.csv.gz', 'rt', encoding='utf-8-sig', newline='') as f:
    rows = csv.reader(f)
    print('CSV header:', next(rows))
    print('Data rows:', sum(1 for _ in rows))
PY
```

This checks the **published compressed file and row count**, not the original
JAR bytes. Compare the reported count with the release summary, accounting for
the header row. The GitHub release's `.sha256` file authenticates the downloaded
CSV *against the publisher's supplied digest*; it is not independent evidence
that the underlying source archives were hashed correctly.

## 3. Hash archived JARs without extracting their original filenames

The reproducible identity of a JAR is the hash of its **decompressed JAR file
bytes**, not the 7z/ZIP container bytes, a URL, or the CRC32 of the enclosing
compressed archive. Compute **SHA-256**, SHA-1, CRC32 and byte size from the
*same* byte stream. `tools/hash_jar_stream.py` uses Python's standard library,
reads in 1 MiB chunks, and outputs those four fields as JSON:

```sh
python3 tools/hash_jar_stream.py /path/to/a-file.jar
```

### A Linux filename too long to extract

Some archive members have individual path components longer than a Linux
filesystem accepts as a filename. This need not prevent hashing the content:
**read or stream the member directly from its container**, without creating
that long path on disk. On Ubuntu, install 7-Zip if needed (`sudo apt install
7zip`); depending on the installed build, the command may be `7z` or `7zz`.
Use `7z l -slt /path/to/archive.7z` to inspect the member names first.

```bash
# Replace both placeholders with the actual archive and its ONE exact member.
ARCHIVE='/path/to/archive.7z'
MEMBER='path/inside/archive/very-long-filename.jar'
set -o pipefail
7z x -so "$ARCHIVE" "$MEMBER" | python3 tools/hash_jar_stream.py -
```

The `-so` option writes decompressed file data to standard output. **Select
exactly one member** (the 7z member argument can behave like a pattern), and
check that the command exits successfully; `set -o pipefail` ensures a 7z error
is not hidden by a successful hash command. The helper also rejects empty input
so a nonexistent or incorrectly selected member is not recorded as a JAR. No original member path is created
on disk. Streaming a member of a solid-compressed archive can still require
substantial decompression work. If your system uses `7zz`, substitute that
executable in the example.

For a ZIP container, Python's `zipfile` module can open the member directly:

```sh
python3 - /path/to/archive.zip 'path/inside/archive/file.jar' <<'PY'
import hashlib, sys, zipfile
archive_name, member_name = sys.argv[1:]
with zipfile.ZipFile(archive_name) as archive, archive.open(member_name) as source:
    digest = hashlib.sha256()
    size = 0
    for block in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(block)
        size += len(block)
print('size:', size, 'sha256:', digest.hexdigest())
PY
```

This is the method to **reproduce a hash check**, not proof of which exact
shell command was used in the original historic scan. If a member is encrypted,
truncated, ambiguously selected, or otherwise unreadable, record the failure
rather than recording a guessed hash. Recheck any result against the published
CSV's SHA-256 and size (and SHA-1/CRC32 when present).

## 4. Associate metadata and source locations without inventing a join

The following describes the **data relationships required for a rebuild**;
this repository does **not** contain the original code that extracted all JAR
manifests or joined them to the verified inventory.

1. Retain one source-location record per encountered archive member: the exact
   archive (Lite/Full), member path, original filename and observed byte size.
2. Hash the decompressed member bytes. Compare SHA-256 to the verified base
   index. Use SHA-256 **of the file bytes** to associate copies with the same
   content; keep all associated locations instead of deduplicating by title or
   filename. SHA-1 and CRC32 are cross-checks, not primary join keys: CRC32
   collisions can occur.
3. For readable JARs, inspect `META-INF/MANIFEST.MF` *inside* the JAR (a ZIP
   container). Relevant fields may include `MIDlet-Name`, `MIDlet-Vendor`,
   `MIDlet-Version`, `MicroEdition-Profile`, and
   `MicroEdition-Configuration`; fields can be missing, wrapped over multiple
   lines, or inconsistent between copies. Preserve unrecognized raw fields
   and missing values; do not fill them in by guessing from the filename.
4. Associate parsed fields, all original source locations and any provenance
   records with the verified content hash. Keep conflicts visible rather than
   silently choosing a value. The exact original conflict-resolution rules,
   normalization and join script versions have **not been recovered** here.
5. Build the enriched CSV/JSONL inputs only from a documented, separately
   available enrichment process. The published base CSV by itself is **not**
   a drop-in replacement for these inputs.

For upstream matching, the existing method documented in
[SOURCES.md](SOURCES.md) compares byte-content SHA-256 values to the verified
base set, independently of the normal search-index pipeline. The published
unmatched-file inventory and upstream download mappings are not generated by
this repository's included scripts.

## 5. The recovered historical v4 site builder

The final version of `build_site.py` before deletion can be inspected directly
from the repository's Git history. The deletion commit is `97a3b2f`; its
first parent contains the last committed version:

```sh
# Run from a Git clone containing the project's history (not a source ZIP).
# Read-only recovery; saves outside the repository and DOES NOT run a build.
git show '97a3b2f^:build_site.py' > /tmp/jarchive-build-site-v4.py
python3 /tmp/jarchive-build-site-v4.py --help
```

This source is evidence for how the **v4** main-index builder operated. It is
not evidence of the exact original command-line invocation or the preceding
enrichment implementation. We inspected this recovered source; **we have not
rerun it on the full enriched inputs**.

### Required v4 inputs and validation

The script **does not extract JARs or compute their hashes**. It uses
Python's standard library, an on-disk temporary SQLite database, and two
**separately generated** inputs:

- `--input jarchive-enriched.csv`: a CSV with the required fields
  `collection`, `archive_file`, `filename`, `archive_path`, `size_bytes`,
  `crc32`, `sha1`, `sha256`, `metadata_status`, `midlet_name`,
  `midlet_vendor`, `midlet_version`, `cldc`, and `midp`. Each row is a source
  occurrence, not necessarily a unique JAR. Only rows with
  `metadata_status=matched` are accepted. The code validates the archive
  name/collection pair (`JARchiveLite v11` / `JARchiveLite_v11.7z` or
  `JARchive v11` / `JARchive_v11.7z`), SHA-1, SHA-256 and CRC32 formatting,
  nonnegative size, and nonempty safe relative archive paths.
- `--details jarchive-enriched-details.jsonl.gz`: gzip-compressed JSON Lines,
  with entries identified by `collection` and `sha256`, plus `manifest` and
  `paths`. The script loads one details entry per `(SHA-256, collection)` into
  SQLite, and fails if an encountered content/collection pair has no details.
  It truncates published manifest keys and values and publishes only a
  configurable number of original paths, while preserving their total count.

The builder defaults to `--expected-count 816215` CSV entries (zero disables
that count check), `--record-chunk 4096`, `--name-shards 64` (an **approximate**
shard target), and `--max-original-paths 2`; `0` publishes none of the original
paths and `-1` publishes all (potentially including private or identifying
historical folder names). `--warn-mib 250` sets only an output-size warning.
These are defaults **in the recovered v4 script**, not a record of the flags
used for the current deployment.

### What the v4 builder generates

1. Sorts enriched source occurrences by SHA-256, archive collection, and
   archive path; groups identical SHA-256 contents into one record with all
   Lite/Full source occurrences. It checks that all copies of the same content
   have consistent SHA-1 and size. Its primary title/vendor/version/CLDC/MIDP
   values prefer Full-collection metadata when present, otherwise the
   available Lite values; this is a **specific historical choice**, not a
   generic rule for rebuilding enrichment data.
2. Assigns sequential content IDs and writes gzip-compressed `records/` and
   `details/` chunks, a manifest and `build-summary.json`.
3. Creates exact SHA-1/SHA-256 lookup buckets and CRC32 lookup buckets.
   CRC32 buckets retain **multiple content IDs** for collisions.
4. Indexes lowercased original filenames, MIDlet names and vendors as search
   labels, deduplicates repeated `(label, ID, kind)` entries, then generates
   the v4 `names/` shards and 2-/3-gram-to-shard bitmaps.
5. Writes to an `.data-v4-staging/` directory inside `--out` before moving it
   into place as `data/`. **A successful run replaces `--out/data/` and
   removes its previous backup**, including any separately generated data
   under that folder. A staging directory does not make running it against
   an active site safe.

The code requires `--out` to contain a site's `index.html` and `assets/app.js`.
For historical research **only**, this is the general shape of its invocation;
`--out` must be a *disposable, isolated copy of the v4 site*, never your
current checkout:

```sh
python3 /tmp/jarchive-build-site-v4.py \
  --input /path/to/jarchive-enriched.csv \
  --details /path/to/jarchive-enriched-details.jsonl.gz \
  --out /path/to/disposable-v4-site \
  --expected-count 816215
```

**Current-schema incompatibility:** This script emits `schema_version: 4`
and a `data/names/` search index. The current deployed application expects a
`data/names-v2/` index with a different manifest/index format (and uses many
more name shards). Merely setting `--name-shards 1024` **does not upgrade the
schema or directory layout**. Do not restore this historical script as an
active production builder, or run it against the current `data/` directory,
without a separate modernization and end-to-end validation effort.

## 6. Rebuild available *current* supplemental indexes, in dependency order

**A complete checkout containing a valid current-schema `data/` is required**
for these included tools. Simply previewing the site requires no rebuild.
If the main index has been rebuilt by a separately verified, compatible
process, run these scripts from the repository root. They write only their
respective supplemental directories under `data/`:

```sh
python3 tools/build_folder_groups.py --repo .
python3 tools/build_search_summaries.py --repo .
```

Rebuild both after any main-index change; summaries also depend on the name
index. They may use substantial disk and time, so do this on a working copy
rather than directly in a live deployment.

## 7. Validate before publishing

Run ordinary regression tests, then integrity checks on the *complete* index:

```sh
python3 tests/check_repo.py
node --test tests/app.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 tests/check_index.py
python3 tools/check_full_index.py --repo .
python3 tools/check_folder_index.py --repo . --require-folders
```

The exhaustive validator checks internal consistency of all core search data
and lookup indexes, **not whether the original JARs match their claimed
hashes**. Folder-index compatibility has its own checker. There is no equivalent
full integrity checker for every optional upstream mapping or retrieval index
in this source tree. Test searches, download links and manifest displays in a
browser before publishing.

## 8. What remains necessary for a complete independent rebuild

A third party cannot fully reproduce the original ingest-to-site pipeline
from this repository alone. To close that gap we would need the historical
source-archive inventory/checksums and exact acquisition details; the
extraction/manifest-enrichment code or a documented substitute; the schema,
join and conflict-resolution rules used to create the enriched CSV and details
JSONL; the exact command/flags used for the historical v4 run; and a **verified
builder for the current main-index schema**, plus the separate retrieval and
upstream-index generation procedures. We have recovered the v4 builder source,
but **not** these remaining components. Record versions, flags and input
checksums before claiming bit-for-bit reproducibility: even a logically
equivalent rebuild can differ in record IDs, ordering or compression details.

Currently supported, verifiable activities are: **checking the published base
CSV's checksum, independently hashing selected original JAR bytes, inspecting
the recovered historical v4 builder, rebuilding two current supplemental
indexes, and exhaustively validating an existing current main index**. None
of these by itself proves full historical ingest-to-site reproducibility.
