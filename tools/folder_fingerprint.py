"""Stable identity digest for web records used by the optional folder index.

Hash the original array-shaped record JSON (UTF-8, unescaped Unicode, compact
separators), followed by a newline for each record in ascending record-ID order.
This binds folder groups to record IDs, source paths and displayed metadata,
not just to the easily unchanged main manifest. Compression bytes don't matter.
"""
import json


def update_record_digest(digest, record):
    digest.update(json.dumps(record, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    digest.update(b'\n')
