# Potential improvements

- [ ] **Search improvements.** Search paths as well as filenames and metadata. Also for search refinements, have a way to exclude terms (e.g., when searching "Sonic" then a bunch of results with "Panasonic" come up and one might want to exclude these). If implemented, there should be a page where this is documented as well as a link to said page as soon as "search refinements" are visible to the user
- [ ] **Optional J2ME-specific search filters.** In a collapsible advanced-filter section, let visitors narrow results by archive collection (Lite/Full), MIDP and CLDC version, file size, and vendor. Handle missing metadata explicitly (e.g., "Unknown") and keep the default search UI uncluttered
- [ ] **Better navigation for large result sets.** Improve handling of very broad queries
- [ ] **Document reproducibility.** Publish or refine the indexing, extraction, hashing and metadata-join methodology, including the overlong Linux filename handled by archive streaming
- [ ] **Metadata quality tools.** Identify conflicting or incomplete manifest fields, as well as fields that could still be added (e.g.,  screen resolution / device compatibility)
- [ ] **Export search results.** Add the ability for users to export the results of their current search in some form
- [ ] **Faster initial result sorting.** Investigate generating a compact sorting-metadata index so switching from Default to title/size sorting doesn't require fetching and decompressing numerous full record shards. (Currently, the first non-default sort takes long, but at least subsequent sorting is nearly instantaneous thanks to caching)
- [ ] **Repo file cleanup.** Review obsolete scripts, generated files, redundant documentation, and temporary development artifacts
- [ ] **End-to-end browser regression tests.** Extend the existing automated checks with browser-based tests covering search, sorting, download links, language switching, and mobile layouts. Use a small representative dataset rather than the complete archive
- [ ] **Full index-integrity validation.** Develop an optional validation script for checking the generated index before publishing major rebuilds. Verify record IDs, shard references, hash formats, counts, and consistency between the name indexes and underlying records. Keep this separate from the lightweight pre-deployment checks because validating the complete archive could be expensive
- [ ] **Check docs.** Make sure that everything is accurate and up-to-date
