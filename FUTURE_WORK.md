# Potential improvements

## Search and browsing

- [ ] **Related builds and versions.** Group different JARs belonging to the same game or app by `MIDlet-Name`, vendor, and other manifest fields. Preserve the distinction between exact hash matches and inferred relationships; allow users to inspect individual variants
- [ ] **Archive-path search and collection filters.** Search paths as well as filenames and metadata
- [ ] **Better navigation for large result sets.** Improve handling of very broad queries
- [ ] **Games-only filtering.** Let users filter probable games from utilities and other apps without removing anything from the preservation index. Classification would need to be labeled as best-effort
- [ ] **Virtual archive explorer.** Browse the original JARchive Full and Lite directory structures with folders, file sizes, checksums, and links to archive members

## Preservation, documentation and maintenance

- [ ] **Investigate archive coverage questions.** Investigate newer or updated J2ME collections for file contents absent from JARchive v11 and Lite v11
- [ ] **Document reproducibility.** Publish or refine the indexing, extraction, hashing and metadata-join methodology, including the overlong Linux filename handled by archive streaming

## Metadata and presentation

- [ ] **Fuller provenance display.** Optionally reveal more than the currently published first two original source locations per manifest, with care for database size, usability, and potentially sensitive historical paths
- [ ] **Metadata quality tools.** Identify conflicting or incomplete manifest fields, as well as fields that could still be added (e.g.,  screen resolution / device compatibility)
