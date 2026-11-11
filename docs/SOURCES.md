# Sources and archive coverage

This document records which Internet Archive collections and which files within them have been examined for the [New J2ME Software Archive Search](https://toca-1.github.io/new-j2me-software-archive-search/). It distinguishes the site's original indexed collection from additional sources used for alternative downloads or for investigating missing JARs. Beware that the project has not re-scraped the original websites and no new JARs were added to the index. It has downloaded existing preservation archives, inspected or hashed their contents, and compared SHA-256 values against the published JARchive index. The New archive's description identifies ten historical upstream collections:

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

# Matching and publication methodology

1. Use the [verified base-index release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) (`jarchive-combined-verified.csv.gz`) as the reference set of SHA-256 hashes.
2. Read `.jar` members in the relevant upstream packages (directly from ZIPs or from extracted 7z contents), calculate SHA-256, and retain the exact containing archive filename and member path. Unified 2019 is an exception: its publisher-provided metadata hashes were used for a coverage-only comparison.
3. Compare byte-content hashes only
4. For supported sources, test at least one individual Internet Archive archive-member URL by downloading the JAR and checking its SHA-256 before adding source mappings
5. Add links for matching hashes to `data/upstream/`. These mappings are separate from the searchable JARchive records

## Missing-file investigation

Files whose SHA-256 values are absent from the original JARchive index are recorded separately in `missing_files/`; the consolidated inventory is: [`missing_files/all_unmatched_deduplicated.csv`](missing_files/all_unmatched_deduplicated.csv). It contains one row per distinct SHA-256 and retains recorded source information and locations. The `source_archives` and `locations_json` columns allow the same file content to be associated with multiple upstream collections without counting it as multiple distinct files.

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
