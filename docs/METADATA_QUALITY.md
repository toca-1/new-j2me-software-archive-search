# Metadata quality audit

`tools/audit_metadata.py` is an audit of the existing search-index metadata. It inventories which values are available, where different source-collection manifests disagree, including Mini-only metadata, and which manifest keys might warrant research for display size, language, or device support.

## Run on the published v2 index

From the repository root (Python 3.9+):

```sh
python3 tools/audit_metadata.py \
  --data ./data \
  --out "$HOME/j2me-metadata-audit-01"
```

It reads the compressed `records/*.json.gz` and corresponding `details/*.json.gz` shards. The generated directory contains:

| File | Contents |
| --- | --- |
| `summary.json` | Unique-file counts, primary metadata coverage, per-collection manifest coverage, missing-value and disagreement counts |
| `manifest-fields.csv` | Every canonical manifest key with the number of collection-detail pairs containing it, the number with a nonblank value, and short examples |
| `possible-extension-fields.csv` | Subset of keys with names suggesting display size, resolution, language, locale, device, platform, or compatibility |
| `examples.csv` | A bounded set of affected record IDs and SHA-256 hashes for investigation; `--max-examples 0` omits examples, default is 12 per issue/field, with an overall maximum of 500 (`--max-total-examples`) |

To display primary version availability without opening the entire report:

```sh
python3 - <<'PY'
import json
from pathlib import Path
report = json.loads((Path.home() / 'j2me-metadata-audit-01/summary.json').read_text())
print('Unique JAR contents:', report['unique_files'])
print('Primary version:', report['primary_fields']['version'])
print('Missing primary version, preferred manifest has value:',
      report['observations']['primary_missing_manifest_present'].get('version', 0))
print('Cross-collection version disagreement:',
      report['observations']['cross_collection_difference'].get('version', 0))
PY
```

Primary metadata selection follows the index builder: **Full** first, then **Lite**, then **Mini** for Mini-only files. The report counts each unique SHA-256 once and counts manifest fields per source/content detail pair. The 225,867 supplementary Mini URLs are not separate metadata records; they are not included in this audit.

## Limitations and safety

This is not a validator for checksum data or JAR-byte contents; run `tools/check_full_index.py` for structural integrity. The audit never changes published data and stages all generated files in a temporary sibling directory before publishing a new report directory. The example CSV contains archive-derived, potentially untrusted text: handle it as data rather than executable instructions. This tool performs no device-compatibility inference and does not generate new index fields or change the website's filters.
