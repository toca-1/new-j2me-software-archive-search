# Sources and archive coverage

This document records the indexed collections and separately examined upstream sources for the [J2ME archive search site](https://toca-1.github.io/new-j2me-software-archive-search/).

## Indexed archive collections (current v2)

The search index combines JARchive v11 (618,031 source entries), JARchiveLite v11 (198,184) from the [New J2ME Software Archive](https://archive.org/details/96x65pixels_j2me), and 96x65pixels J2ME Mini (1,428 new source entries) from [the Mini collection](https://archive.org/details/96x65pixels_j2me_mini). The v2 index contains 817,643 source entries representing 621,715 unique SHA-256 file contents. Its separate Mini SHA-1 lookup provides 225,867 individual-member URLs, most pointing to files already present in v1 rather than creating duplicate records. See the [index-v2 release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v2) for the verified CSV and its checksum.

The description of the original JARchive identifies ten historical upstream collections:

| Historical upstream collection | Processing performed for this project |
| --- | --- |
| [Opera Mini](https://archive.org/details/opera-mini-j2me-archive) | Everything scanned |
| [Waptrick](https://archive.org/details/dump_waptrick_240x320_128x160) | Everything scanned |
| [Waper.ru](https://archive.org/details/waper_ru_death) | Everything scanned |
| [Dedomil](https://archive.org/details/dedomil.net.7z) | Everything scanned |
| [7723.cn](https://archive.org/details/7723_cn_dump) | Everything scanned |
| [Phoneky / DownloadWAP](https://archive.org/details/phoneky_dump) | Phoneky-J2ME-MissingFromNewDump.7z, Phoneky-J2ME-Apps.7z, Phoneky-J2ME-Games.7z |
| [Unified J2ME Archive (2019)](https://archive.org/details/j2me-archive-unified-2019-09) | Publisher-provided SHA-256 catalogue compared, JARs not extracted for independent hashing because no direct download links |
| [J2ME Software Archives - May 2020](https://archive.org/details/J2MEarchivesMay2020) | J2ME-Archives-May-2020-Sites-x16.7z, ...-x17.7z, and ...-x20.7z through ...-x23.7z |
| [Ovi Store Panic (2015)](https://archive.org/details/2015_ovi_store_panic) | Not processed; downloads unavailable |
| [Ovi Store Panic 2 (2015)](https://archive.org/details/2015_ovi_store_panic_2) | Not processed; downloads unavailable |

Additionally, the third-party mirror [nnproject](https://f.nnproject.cc/jarchive/) has been incorporated into the site. Instructions on how to rebuild directly from the original archives can be found [in the readme](https://github.com/toca-1/new-j2me-software-archive-search/blob/main/docs/README.md#run-or-rebuild-locally).

# Matching and publication methodology

1. Use the [verified base-index release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) (`jarchive-combined-verified.csv.gz`) as the reference set of SHA-256 hashes.
2. Read `.jar` members in the relevant upstream packages (directly from ZIPs or from extracted 7z contents), calculate SHA-256, and retain the exact containing archive filename and member path. Unified 2019 is an exception: its publisher-provided metadata hashes were used for a coverage-only comparison.
3. Compare byte-content hashes only
4. For supported sources, test at least one individual Internet Archive archive-member URL by downloading the JAR and checking its SHA-256 before adding source mappings
5. Add links for matching hashes to `data/upstream/`. These mappings are separate from the searchable JARchive records

## Missing-file investigation (historical v1 comparison)

Files whose SHA-256 values are absent from the original JARchive index are recorded separately in `missing_files/`. The consolidated inventory, `missing_files/all_unmatched_deduplicated.csv`, is a separate large dataset which contains one row per distinct SHA-256 and retains recorded source information and locations. The `source_archives` and `locations_json` columns allow the same file content to be associated with multiple upstream collections without counting it as multiple distinct files.

### Deduplicated results

As of November 11, 2026:

| Metric | Count |
| --- | ---: |
| Distinct SHA-256 values absent from the base index | 134,110 |
| Distinct recorded source locations | 210,152 |
| Missing hashes present in two or more upstream collections | 25,618 |
| Missing hashes with at least one candidate download URL | 59,734 |
| Missing hashes without a recorded candidate URL | 74,376 |
| Missing hashes associated with at least one `.jar` filename | 134,042 |
| Missing hashes without a `.jar` filename | 68 |

These results were obtained by comparing the available unmatched inventories against the 620,287 distinct SHA-256 values in the verified base index.
