# Potential improvements

- [ ] **Search improvements.** Search paths as well as filenames and metadata. Also for search refinements, have a way to exclude terms (e.g., when searching "Sonic" then a bunch of results with "Panasonic" come up and one might want to exclude these). If implemented, there should be a page where this is documented as well as a link to said page as soon as "search refinements" are visible to the user
- [ ] **Better navigation for large result sets.** Improve handling of very broad queries
- [ ] **Document reproducibility.** Publish or refine the indexing, extraction, hashing and metadata-join methodology, including the overlong Linux filename handled by archive streaming
- [ ] **Metadata quality tools.** Identify conflicting or incomplete manifest fields, as well as fields that could still be added (e.g.,  screen resolution / device compatibility)
- [ ] **Export search results.**
- [ ] **Check docs.** Make sure that everything is accurate and up-to-date
- [ ] **Faster initial result sorting.** Investigate generating a compact sorting-metadata index so switching from Default to title/size sorting doesn't require fetching and decompressing numerous full record shards. (Currently, the first non-default sort takes long, but at least subsequent sorting is nearly instantaneous thanks to caching)
- [ ] **Stronger folder-index compatibility checks.** Improve the compatibility check between the folder-group index and the main record index. Currently, it relies on the SHA-256 of `data/manifest.json`, which might remain unchanged even if record contents or ID assignments change during a rebuild. Consider using a fingerprint or build identifier tied to the actual record data to prevent incorrect folder associations
- [ ] **Repo file cleanup.** (if needed)
