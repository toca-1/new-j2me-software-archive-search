# Potential improvements

## Preservation, documentation and maintenance

- [ ] **Document reproducibility.** Publish or refine the indexing, extraction, hashing and metadata-join methodology, including the overlong Linux filename handled by archive streaming.
- [ ] **Investigate archive coverage questions.** Compare the list of archives mentioned underneath ["New" J2ME](https://archive.org/details/96x65pixels_j2me) with the links in the "Known sources of valuable files (good or bad dumps)" sections of this [JAR integrity guide](https://lpcwiki.miraheze.org/wiki/JAR_integrity_guide) and maybe extend the search index to more sites/sources; although many of the missing sites or files could be bad dumps and were excluded on purpose?
- [ ] **Review dataset rights and attribution (optional).** The project's original code is MIT-licensed, and the README includes an independent-project disclaimer and credits the source archive. Revisit the rights and redistribution conditions of archive-derived datasets if considering a separate dataset license in the future.
- [ ] **Windows-friendly retrieval / extraction.** Document an alternative way to retrieve specific JARs on Windows, including an offline method for people who already have either 7z file.

## Search and browsing

- [ ] **Virtual archive explorer.** Browse the original JARchive Full and Lite directory structures with folders, file sizes, checksums, and links to archive members.
- [ ] **Related builds and versions.** Group different JARs belonging to the same game or app by `MIDlet-Name`, vendor, and other manifest fields. Preserve the distinction between exact hash matches and inferred relationships; allow users to inspect individual variants.
- [ ] **Archive-path search and collection filters.** Search paths as well as filenames and metadata; optionally filter to JARchiveLite, JARchive Full, or both.
- [ ] **Better navigation for large result sets.** Add useful sorting and filtering (e.g. file size, version, vendor, platform), and improve handling of very broad queries.
- [ ] **Games-only filtering.** Let users filter probable games from utilities and other apps without removing anything from the preservation index. Classification would need to be labeled as best-effort.
- [ ] **Screen resolution / device compatibility.** Investigate extracting target screen-size hints from JAR resources, filenames, original paths, and manifests. Not every JAR reliably declares a resolution; do not label inferred values as guaranteed or automatically assume higher resolution means a better version.

## Metadata and presentation

- [ ] **Fuller provenance display.** Optionally reveal more than the currently published first two original source locations per manifest, with care for database size, usability, and potentially sensitive historical paths.
- [ ] **Metadata quality tools.** Identify conflicting or incomplete manifest fields; allow users to distinguish archive-supplied metadata from verified checksums and inferred game associations.
