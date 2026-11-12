# Potential improvements

## Search and browsing

- [ ] **Related builds and versions.** Group different JARs belonging to the same game or app by `MIDlet-Name`, vendor, and other manifest fields. Preserve the distinction between exact hash matches and inferred relationships; allow users to inspect individual variants
- [ ] **Archive-path search.** Search paths as well as filenames and metadata
- [ ] **Better navigation for large result sets.** Improve handling of very broad queries
- [ ] **Virtual archive explorer.** Browse the original JARchive Full and Lite directory structures with folders, file sizes, checksums, and links to archive members. **EDIT: This exists!** https://f.nnproject.cc/jarchive/ Check how this site can be used for other points on this list, e.g., more download links, groups related games, etc.
- [ ] **Speed up the search.** (Somehow??)

## Preservation, documentation and maintenance

- [ ] **Investigate archive coverage questions.** Investigate newer or updated J2ME collections for file contents absent from the current list
- [ ] **Investigate unmatched upstream JARs.** Review CSV inventories in `missing_files/`, dedupe them, distinguish missing builds from repacked, modified, or corrupted files, and document findings before considering any additions to the index
- [ ] **Document reproducibility.** Publish or refine the indexing, extraction, hashing and metadata-join methodology, including the overlong Linux filename handled by archive streaming

## Metadata and presentation

- [ ] **Metadata quality tools.** Identify conflicting or incomplete manifest fields, as well as fields that could still be added (e.g.,  screen resolution / device compatibility)
