# Implementation checklist (suggested order)

Use this as a **working sequence**; the full ideas list remains in [`FUTURE_WORK.md`](FUTURE_WORK.md). The order balances impact, risk, dependencies, and development effort. Check a box only after tests pass in the checkout containing the generated `data/` index and a manual browser smoke test succeeds. Keep each feature in its own commit where practical.

## Stage 1 — Reliability and clear feedback (small changes)

- [ ] **1. Audit and correct the docs.** Check claims and commands against the repository, clarify which generated data and builder files are not shipped, and align CI documentation with the actual workflow. **Done when:** all documented commands match files and actions, and source-only limitations are explicit. *An initial pass is included with the first patch; recheck against your full VM checkout before marking complete.*
- [ ] **2. Handle search-load errors gracefully.** Display a localized explanation and a working **Retry search** button after fetch retries fail, while keeping invalid queries distinct from network failures and never showing partial results. **Done when:** a simulated missing/503 shard or network exception can fail and then recover using Retry; all locale keys and automated tests pass. *Implementation included with the first patch; manually test in your VM before marking complete.*
- [ ] **3. Strengthen folder-index compatibility.** Tie the folder-group index to the actual record build/ID assignments instead of only the manifest bytes. **Done when:** a record-order change causes a clear incompatibility warning and no wrong folder associations appear.

## Stage 2 — Better core search and usability

- [ ] **4. Implement exclusion terms in result refinement.** Define syntax (e.g. `sonic -panasonic`) and document it in a dedicated help page linked from the visible refine UI. **Done when:** inclusion/exclusion works with Unicode, multiple terms and existing sort modes; old plain-text refinements remain unchanged.
- [ ] **5. Improve large-result navigation.** Add pagination, jumping, or other controls that avoid generating huge DOM result lists. **Done when:** broad queries remain responsive on desktop and mobile, without losing relevance ordering.
- [ ] **6. Introduce browser end-to-end tests.** Use a **small synthetic index**, covering search, sorting, Retry, downloads, language switching and mobile layouts. **Done when:** one reproducible VM/CI command detects common UI regressions.

## Stage 3 — Expand discovery capabilities

- [ ] **7. Reduce initial sort/refinement latency.** Benchmark current behavior first, then evaluate a compact sorting-metadata index rather than loading many full record chunks. **Done when:** representative broad-result benchmarks improve without large, unexplained new downloads.
- [ ] **8. Add archive-path search.** Extend the index builder and search UI to match archive member paths, with clear ranking semantics and appropriate controls. **Done when:** existing title/filename/vendor searches work as before, and path-only matches become discoverable.
- [ ] **9. Add optional J2ME-specific filters.** A collapsed advanced panel for collection, MIDP/CLDC, size, and vendor; include an explicit Unknown state. **Done when:** combinations of filters produce correct results without cluttering the default UI.
- [ ] **10. Export current results.** Choose a format (e.g. CSV) and scope (current refinement/sort or all matches); warn about very large exports. **Done when:** exported rows match the user's visible search criteria and hashes are intact.

## Stage 4 — Index longevity and maintainability

- [ ] **11. Add optional full index-integrity validation.** Verify all record IDs, search references, hash formats and counts separately from the fast CI smoke check. **Done when:** injected inconsistencies fail with actionable diagnostics, and large index rebuilds can be validated deliberately.
- [ ] **12. Document reproducibility.** Describe verification, extraction, hashing, manifest enrichment, joins, and the archive-streaming workaround for an overlong Linux filename. **Done when:** another maintainer can reproduce the pipeline from documented inputs and tools.
- [ ] **13. Develop metadata-quality reports.** Flag contradictory/missing manifest fields; explore device compatibility and resolution only where data supports them. **Done when:** reports distinguish unknown metadata from validated values and do not invent compatibility claims.
- [ ] **14. Clean obsolete repository files.** Remove only files shown to be unused; preserve source archives, attribution, data-generation artifacts and deployment dependencies. **Done when:** tests and deployment remain intact, and cleanup is a reviewable independent commit.

## Ubuntu VM verification (at each stage)

From the repository root, with Python 3 and Node.js 18+ available:

```bash
python3 tests/check_repo.py
node --check assets/app.js
node --check assets/i18n.js
node --test tests/app.test.cjs
python3 -m unittest discover -s tests -p 'test_check_index.py'
```

If the checkout contains the **complete** generated `data/` directory, additionally run:

```bash
python3 tests/check_index.py
python3 -m http.server 8000
```

Visit <http://localhost:8000/> and exercise the feature before committing. Do **not** expect a source-only ZIP to serve searches: it omits the generated index.
