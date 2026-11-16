# Offline pre-deployment regression checks

These checks need **Python 3** and **Node.js 18+**; there are no pip or npm dependencies.
They do not download or rebuild the large J2ME index.

From the repository root:

```sh
python3 tests/check_repo.py
node --check assets/app.js
node --check assets/i18n.js
node --test tests/app.test.cjs
```

- `check_repo.py` checks Python syntax, translation keys and placeholders, local HTML assets, and consistency between the checked-in summary and manifest.
- `app.test.cjs` tests selected functions from the real `assets/app.js` with lightweight mocks: URL encoding, name-shard selection/search caching, CRC32 collisions, exact SHA-256 lookup, refinement/sorting, and retry handling.
- The Pages deployment workflow runs these checks before preparing or uploading the site. A failure stops that deployment; the previously published site stays online.

**Limits:** This is not a browser end-to-end test. It does not validate the omitted large generated shards or live Internet Archive/mirror URLs. Keep manual VM/browser testing for changes affecting rendering, download links and new index builds.
