# Sources and archive coverage

*Working draft — status as of 11 November 2026. The May 2020 investigation is still in progress.*

This document records which Internet Archive collections and **which files within them** have been examined for the [New J2ME Software Archive Search](https://toca-1.github.io/new-j2me-software-archive-search/). It distinguishes the site's original indexed collection from additional sources used for alternative downloads or for investigating missing JARs.

**The project has not re-scraped the original websites.** It has downloaded existing preservation archives, inspected or hashed their contents, and compared SHA-256 values against the published JARchive index. The project does not host JAR files.

## What the website indexes

The searchable base index comprises **JARchive v11** and **JARchiveLite v11** from TwoSpacesSG's ["New" J2ME Software Archive](https://archive.org/details/96x65pixels_j2me): **816,215 archived file entries representing 620,287 distinct SHA-256 file contents**. This is the content covered by the searchable records and the existing command-line downloader.

The New archive's description identifies **ten historical upstream Internet Archive collections**, listed below. The additional processing documented here does **not** imply that all files in each upstream collection were included in JARchive v11/Lite v11. Exact SHA-256 matches can be linked to the existing site; nonmatching hashes are tracked separately for possible future investigation.

## Overview

| Historical upstream collection | Processing performed for this project | Website download links |
| --- | --- | --- |
| [Opera Mini](https://archive.org/details/opera-mini-j2me-archive) | All JAR members of its ZIP scanned | Added |
| [Waptrick](https://archive.org/details/dump_waptrick_240x320_128x160) | All seven ZIP packages scanned | Added |
| [Waper.ru](https://archive.org/details/waper_ru_death) | JAR members of `waper.ru-deathgrab.7z` scanned | Added |
| [Dedomil](https://archive.org/details/dedomil.net.7z) | JAR members of `dedomil.net.7z` scanned | Added |
| [7723.cn](https://archive.org/details/7723_cn_dump) | JAR members of `7723.cn.7z` scanned | Added |
| [Phoneky / DownloadWAP](https://archive.org/details/phoneky_dump) | Three J2ME 7z packages scanned; Symbian packages excluded | Added |
| [Unified J2ME Archive (2019)](https://archive.org/details/j2me-archive-unified-2019-09) | Publisher-provided SHA-256 catalogue compared; JARs not extracted for independent hashing | Not added; tested member URL returned HTTP 404 |
| [J2ME Software Archives — May 2020](https://archive.org/details/J2MEarchivesMay2020) | Three packages' directly stored JARs scanned; additional packages in progress | Not added yet; one standalone 7z member URL verified |
| [Ovi Store Panic (2015)](https://archive.org/details/2015_ovi_store_panic) | Not processed; downloads unavailable | Not added |
| [Ovi Store Panic 2 (2015)](https://archive.org/details/2015_ovi_store_panic_2) | Not processed; downloads unavailable | Not added |

“Added” means that matching hashes have been incorporated into the separate upstream-download lookup data, **not** that new JARs were added to the searchable base index. The live source catalog is `data/upstream/sources.json`; the compressed mappings are under `data/upstream/`.

## Collections with alternative download links

### Opera Mini

- Internet Archive item: [`opera-mini-j2me-archive`](https://archive.org/details/opera-mini-j2me-archive)
- Processed file: `opera-mini-j2me.zip`
- Scan: **6,932 JAR entries**, **6,859 distinct SHA-256 values**; **6,859 matched**, **0 unmatched**.
- At least one ZIP-member download was independently checked against SHA-256.
- One upstream location is selected per matching hash for display.

### Waptrick

- Internet Archive item: [`dump_waptrick_240x320_128x160`](https://archive.org/details/dump_waptrick_240x320_128x160)
- Processed **all seven ZIP packages**:
  - `juegos_101x80_siem55_waptrick.zip`
  - `juegos_128x128_s40_waptrick.zip`
  - `juegos_128x160_y_240x320_s40_waptrick.zip`
  - `juegos_176x208_s60_waptrick.zip`
  - `juegos_176x220_se_waptrick.zip`
  - `juegos_240x320_s60_waptrick.zip`
  - `juegos_96x65_s40_waptrick.zip`
- Scan: **11,789 JAR entries**, **10,796 distinct SHA-256 values**; **10,255 matched**, **541 unmatched**.
- A ZIP-member URL was successfully downloaded and its SHA-256 checked.
- Missing-hash inventory: `missing_files/waptrick_unmatched.csv`.

### Waper.ru

- Internet Archive item: [`waper_ru_death`](https://archive.org/details/waper_ru_death)
- Processed file: `waper.ru-deathgrab.7z`
- Scan: **101,257 JAR entries**, **60,732 distinct SHA-256 values**; **50,302 matched**, **10,430 unmatched**.
- A 7z-member URL was successfully downloaded and its SHA-256 checked.
- Missing-hash inventory: `missing_files/waper_unmatched.csv`.

### Dedomil

- Internet Archive item: [`dedomil.net.7z`](https://archive.org/details/dedomil.net.7z)
- Processed file: `dedomil.net.7z`
- Scan: **76,858 JAR entries**, **73,957 distinct SHA-256 values**; **73,867 matched**, **90 unmatched**.
- A 7z-member URL was successfully downloaded and its SHA-256 checked.
- Missing-hash inventory: `missing_files/dedomil_unmatched.csv`.

### 7723.cn

- Internet Archive item: [`7723_cn_dump`](https://archive.org/details/7723_cn_dump)
- Downloaded wrapper: `7723_cn_dump.zip`; processed its inner `7723.cn.7z` (also listed as a standalone Internet Archive file).
- Scan: **105,274 JAR entries**, **103,780 distinct SHA-256 values**; **103,258 matched**, **522 unmatched**.
- A direct member URL from `7723.cn.7z` was successfully downloaded and its SHA-256 checked.
- Missing-hash inventory: `missing_files/7723_unmatched.csv`.
- The archive also includes `7723.cn-list.csv`, `7723.cn-list.txt`, and `7723.cn-URLmap.txt`; these were **not** used in the SHA-256 matching process described above.

### Phoneky / DownloadWAP

- Internet Archive item: [`phoneky_dump`](https://archive.org/details/phoneky_dump)
- Processed **only the three J2ME packages**, not the Symbian Apps or Symbian Games archives:

| Processed file | JAR entries | Distinct SHA-256 | Matched | Unmatched |
| --- | ---: | ---: | ---: | ---: |
| `Phoneky-J2ME-MissingFromNewDump.7z` | 591 | 591 | 573 | 18 |
| `Phoneky-J2ME-Apps.7z` | 24,739 | 16,250 | 15,571 | 679 |
| `Phoneky-J2ME-Games.7z` | 159,730 | 108,152 | 83,739 | 24,413 |

- The per-package counts **cannot be added to obtain globally distinct Phoneky hashes**, because content may occur in more than one package.
- Sample direct downloads from the 7z packages were verified by SHA-256 before publication.
- The published source catalog has separate entries for the three 7z files, all displayed as **Phoneky**.
- Combined missing-hash inventory: `missing_files/phoneky_unmatched.csv`.
- The Phoneky Apps/Games list CSVs provide application metadata but no SHA-256 column, so JAR content was hashed directly.

## Coverage-only comparison

### Unified J2ME Archive (September 2019)

- Internet Archive item: [`j2me-archive-unified-2019-09`](https://archive.org/details/j2me-archive-unified-2019-09)
- Downloaded the **43 parts** of `j2me-archive-unified-2019-09.7z.001` through `.043`; the first part was supplied inside `j2me-archive-unified-2019-09.7z.001.zip`.
- `7z t` reported **Everything is Ok** for the combined archive.
- Examined the included `j2me.csv`, `j2me.sqlite3`, and `dups.txt` metadata. The archive listing includes **532,997 `.jar` entries**, of which **217,639 were identified as symbolic links**.
- Compared publisher-provided hashes from `j2me.csv` **without extracting and rehashing all JAR contents**:
  - **534,755 metadata rows**; **12,837** rows without valid SHA-256 values.
  - **307,430 distinct valid SHA-256 values**; **207,885 matched** the JARchive index, **99,545 unmatched**.
  - Unmatched values include some non-`.jar` filenames and have **not** all been independently verified as valid JAR files.
- A hypothetical URL into the unsplit `.7z` returned **HTTP 404**. Since the item distributes split 7z parts, **no alternative browser download links have been published** for this collection.
- Missing-hash inventory: `missing_files/unified_unmatched.csv`.

## J2ME Software Archives — May 2020 (in progress)

- Internet Archive item: [`J2MEarchivesMay2020`](https://archive.org/details/J2MEarchivesMay2020)
- **This is a partial inventory, not a scan of the entire Internet Archive item.**
- Three downloaded packages have been scanned **for directly stored JARs only**:

| Downloaded package | Actual JAR container | JARs hashed | Distinct SHA-256 | Matched | Unmatched | Direct member download |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `J2ME-archives-May-2020-FSN-1.zip` | Inner `J2ME-archives-May-2020-FSN-1.7z` | 2,386 | 2,157 | 2,021 | 136 | Tested nested ZIP → 7z → JAR URL: HTTP 404 |
| `J2ME-Archives-May-2020-sites-x19.zip` | Inner `J2ME-Archives-May-2020-sites-x19.7z` | 18,588 | 15,789 | 15,651 | 138 | Tested nested ZIP → 7z → JAR URL: HTTP 404 |
| `J2ME-Archives-May-2020-Sites-x21.7z` | Standalone 7z | 16,536 | 16,209 | 15,282 | 927 | **Verified**: member downloaded with expected SHA-256 |

- These figures cover **37,510 hashed JAR entries**, not nested JAR contents. Totals of distinct hashes across packages are not yet deduplicated.
- The outer archive listings contained **4,003 nested archive entries** across these three packages. Their contents have **not** yet been comprehensively examined; do not treat these results as complete coverage.
- FSN-1's initial archive listing counted **2,390 `.jar` entries**, whereas 2,386 were scanned after extraction. The discrepancy still requires examination.
- Further standalone 7z packages selected for download, **not yet recorded as scanned or integrated**:
  - `J2ME-Archives-May-2020-sites-x16.7z`
  - `J2ME-Archives-May-2020-sites-x17.7z`
  - `J2ME-Archives-May-2020-Sites-x20.7z`
  - `J2ME-Archives-May-2020-Sites-x22.7z`
  - `J2ME-Archives-May-2020-Sites-x23.7z`
- The remaining ZIP-wrapped and other packages in this large item have not yet been processed systematically.
- May 2020 results have **not yet been incorporated** into `data/upstream/` or a final `missing_files/` inventory.

## Unavailable historical sources

The New archive also names two [2015 Ovi Store collections](https://archive.org/details/2015_ovi_store_panic):

- [`2015_ovi_store_panic`](https://archive.org/details/2015_ovi_store_panic)
- [`2015_ovi_store_panic_2`](https://archive.org/details/2015_ovi_store_panic_2)

Their downloads were unavailable during this investigation. **Neither was downloaded, hashed, or added as an alternative source**. Their historical contribution to the New archive should not be confused with processing performed by this project.

## Matching and publication methodology

1. Use the [verified base-index release](https://github.com/toca-1/new-j2me-software-archive-search/releases/tag/index-v1) (`jarchive-combined-verified.csv.gz`) as the reference set of SHA-256 hashes.
2. Read `.jar` members in the relevant upstream packages (directly from ZIPs or from extracted 7z contents), calculate SHA-256, and retain the **exact containing archive filename and member path**. Unified 2019 is an exception: its publisher-provided metadata hashes were used for a coverage-only comparison.
3. Compare **byte-content hashes**, not filenames, MIDlet names, or sizes. A matching hash establishes identical content even if the archived path differs.
4. For supported sources, test at least one individual Internet Archive archive-member URL by downloading the JAR and checking its SHA-256 before adding source mappings. A successful sample does **not** guarantee that every member link will always be available.
5. Add links for matching hashes to `data/upstream/`. These mappings are separate from the searchable JARchive records; **unmatched files are not automatically added to the site**.
6. Preserve unmatched-hash inventories under `missing_files/` for later deduplication and investigation. A missing SHA-256 is a potential coverage gap, not proof that the file is a new or legitimate game build.

The downloadable JARs remain on Internet Archive. Some archive-member requests can fail or time out; the website's original command-line fallback applies to its original JARchive retrieval mechanism, **not automatically to upstream-only files**.

## Future audit and maintenance

- Finish the May 2020 packages, assess nested archive contents, and distinguish directly downloadable members from coverage-only data.
- Deduplicate all `missing_files/` inventories by SHA-256, retaining associated source archives and original paths. Assess direct-download availability before considering any expansion of the searchable index.
- Investigate Unified 2019 rows with invalid/missing hashes and resolve the FSN-1 four-entry discrepancy.
- If reprocessing sources, check the **exact archive filename, member path, SHA-256, and current Internet Archive availability**; archive contents and download behavior may change.
- Record later additions and their completed verification status here. Avoid counting the same SHA-256 in different upstream collections as distinct content.

This is an inventory of sources *used by this independent indexing project*, not an assertion of ownership, redistribution rights, or endorsement by the upstream archivists or Internet Archive. See [README.md](README.md) for licensing and download limitations.
