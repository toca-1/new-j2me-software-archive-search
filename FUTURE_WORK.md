# Potential improvements

## Preservation, documentation and maintenance

- [ ] **Document reproducibility.** Publish or refine the indexing, extraction, hashing and metadata-join methodology, including the overlong Linux filename handled by archive streaming
- [ ] **Investigate archive coverage questions.** Investigate newer or updated J2ME collections for file contents absent from JARchive v11 and Lite v11

## Search and browsing

- [ ] **Virtual archive explorer.** Browse the original JARchive Full and Lite directory structures with folders, file sizes, checksums, and links to archive members
- [ ] **Related builds and versions.** Group different JARs belonging to the same game or app by `MIDlet-Name`, vendor, and other manifest fields. Preserve the distinction between exact hash matches and inferred relationships; allow users to inspect individual variants
- [ ] **Archive-path search and collection filters.** Search paths as well as filenames and metadata; optionally filter to JARchiveLite, JARchive Full, or both
- [ ] **Better navigation for large result sets.** Add useful sorting and filtering (e.g. file size, version, vendor, platform), and improve handling of very broad queries
- [ ] **Games-only filtering.** Let users filter probable games from utilities and other apps without removing anything from the preservation index. Classification would need to be labeled as best-effort
- [ ] **Screen resolution / device compatibility.** Investigate extracting target screen-size hints from JAR resources, filenames, original paths, and manifests. Not every JAR reliably declares a resolution; do not label inferred values as guaranteed or automatically assume higher resolution means a better version

## Metadata and presentation

- [ ] **Fuller provenance display.** Optionally reveal more than the currently published first two original source locations per manifest, with care for database size, usability, and potentially sensitive historical paths
- [ ] **Metadata quality tools.** Identify conflicting or incomplete manifest fields; allow users to distinguish archive-supplied metadata from verified checksums and inferred game associations.
