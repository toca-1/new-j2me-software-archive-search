# Rebuild from the original archives

Requirements: Ubuntu, Python **3.10+**, **7-Zip** (`sudo apt install python3 7zip`),
and enough disk space for temporary extraction (Full is ~217 GiB; Lite ~59 GiB).

Place these three downloads in `~/Downloads/`:

- `JARchive_v11.7z`
- `JARchiveLite_v11.7z`
- `96x65pixels_j2me_mini.zip` (contains nine Mini `.7z` packages)

From the repository root run:

```sh
python3 tools/rebuild_independent.py
```

The script hashes the JAR **bytes**, reads their manifests, deduplicates by
SHA-256 and generates/validates all website search data without consulting the
existing `data/` or any historical index/release. It handles overlong Full
filenames and Mini filenames with undecodable bytes. Interrupted runs can be
resumed by rerunning the command.

Outputs (outside the checkout):

- `~/j2me-independent-rebuild/independent-output/jarchive-combined-verified-v2.csv.gz`
- `~/j2me-independent-rebuild/independent-output/website-preview/`
  (complete independent website preview, with a generated `data/` directory)

To preview:

```sh
python3 -m http.server --directory "$HOME/j2me-independent-rebuild/independent-output/website-preview" 8001
```

Open <http://localhost:8001/>. To change the working/output location set
`J2ME_REBUILD_HOME` to a directory **outside** the repository before running
(the default is `~/j2me-independent-rebuild`). The generated gzip CSV has the
same source-row schema, not necessarily the same compressed bytes as a release.
The searchable metadata is extracted from JAR manifests and may differ from
historical enrichment. Separately sourced `data/upstream/` mirrors and
`retrieval/v1/` downloader mappings **are not regenerated or overwritten**.
Keep those existing site assets when publishing a rebuilt `data/` tree.
