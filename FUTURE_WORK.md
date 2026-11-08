# Potential improvements

## Search and browsing

- [ ] **Virtual archive explorer.** Browse the original JARchive Full and Lite directory structures with folders, file sizes, checksums, and links to archive members.
- [ ] **Related builds and versions.** Group different JARs belonging to the same game or app by `MIDlet-Name`, vendor, and other manifest fields. Preserve the distinction between exact hash matches and inferred relationships; allow users to inspect individual variants.
- [ ] **Archive-path search and collection filters.** Search paths as well as filenames and metadata; optionally filter to JARchiveLite, JARchive Full, or both.
- [ ] **Better navigation for large result sets.** Add useful sorting and filtering (e.g. file size, version, vendor, platform), and improve handling of very broad queries.
- [ ] **Games-only filtering.** Let users filter probable games from utilities and other apps without removing anything from the preservation index. Classification would need to be labeled as best-effort.
- [ ] **Screen resolution / device compatibility.** Investigate extracting target screen-size hints from JAR resources, filenames, original paths, and manifests. Not every JAR reliably declares a resolution; do not label inferred values as guaranteed or automatically assume higher resolution means a better version.

## Metadata and presentation

- [ ] **Further visual redesign.** Refine typography, spacing, result-card layout, accessibility and mobile presentation in response to user feedback.
- [ ] **Fuller provenance display.** Optionally reveal more than the currently published first two original source locations per manifest, with care for database size, usability, and potentially sensitive historical paths.
- [ ] **Metadata quality tools.** Identify conflicting or incomplete manifest fields; allow users to distinguish archive-supplied metadata from verified checksums and inferred game associations.
- [ ] **Better title.** Put a title which describes more specifically what it is about rather than a generic title

## Downloads and offline use

- [ ] **More resilient retrieval instructions.** Offer useful fallbacks when Internet Archive's per-JAR archive viewer is slow, returns a zero-byte response, or fails with HTTP 504. These failures may occur on Internet Archive's side and are not necessarily caused by the search website.
- [ ] **Windows-friendly retrieval / extraction.** Document an alternative way to retrieve specific JARs on Windows, including an offline method for people who already have either 7z file.
- [ ] **Edge-case download testing.** Test filenames containing Unicode, `#`, `%`, slashes inside archive paths, and other punctuation against Internet Archive's generated member links.

## Preservation, documentation and maintenance

- [ ] **Document reproducibility.** Publish or refine the indexing, extraction, hashing and metadata-join methodology, including the overlong Linux filename handled by archive streaming.
- [ ] **Review licensing and attribution.** Keep the independent-project disclaimer, credit TwoSpacesSG and source collections, and review rights before choosing a license for code or derived datasets.
- [ ] **Keep the static site efficient.** Monitor initial search speed, memory use, generated file count and GitHub Pages deployment reliability as the index evolves.
- [ ] **Local archival housekeeping.** Back up verified CSVs, summaries, scripts and source archives before cleaning the Ubuntu VM, shared folder and working directories.
- [ ] **Investigate archive coverage questions.** Compare the list of archives mentioned underneath ["New" J2ME](https://archive.org/details/96x65pixels_j2me) with the links in the "Known sources of valuable files (good or bad dumps)" sections of this [JAR integrity guide](https://lpcwiki.miraheze.org/wiki/JAR_integrity_guide) and maybe extend the search index to more sites/sources; although many of the missing sites or files could be bad dumps and were excluded on purpose?

## Suggestions

Feature requests, corrections, and documented download problems are welcome via the [GitHub repository](https://github.com/toca-1/new-j2me-software-archive-search). Include an exact filename or checksum when reporting an issue with a particular build.
