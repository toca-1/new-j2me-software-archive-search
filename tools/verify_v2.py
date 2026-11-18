#!/usr/bin/env python3
"""Check that a v2 candidate preserved every old record/detail and added exactly the mini-only SHA-1 set."""
from __future__ import annotations
import argparse
import csv
import gzip
import json
from pathlib import Path
import sqlite3
import sys
import tempfile


def shards(data):
    manifest = json.loads((data/'manifest.json').read_text(encoding='utf-8'))
    count, chunk = manifest['unique_files'], manifest['record_chunk']
    seen = 0
    for n in range((count + chunk - 1)//chunk):
        with gzip.open(data/'records'/f'{n:04d}.json.gz','rt',encoding='utf-8') as f:
            records=json.load(f)
        with gzip.open(data/'details'/f'{n:04d}.json.gz','rt',encoding='utf-8') as f:
            details=json.load(f)
        if len(records)!=len(details):
            raise ValueError(f'Unequal record/detail shard {n}')
        seen += len(records)
        yield from zip(records,details)
    if seen!=count:
        raise ValueError('Incorrect number of record shards')


def verify(old, new, mini, expected_old=620287, expected_new=621715,
           expected_rows=817643, expected_mini=1428):
    old_m = json.loads((old/'manifest.json').read_text())
    new_m = json.loads((new/'manifest.json').read_text())
    if (old_m['unique_files'], new_m['unique_files'], new_m['total_rows'],
        new_m['mini_only'],new_m['mini_rows']) != (expected_old,expected_new,expected_rows,expected_mini,expected_mini):
        raise ValueError(f'Unexpected index totals: {new_m}')
    with tempfile.TemporaryDirectory(prefix='v2-verify-') as td:
        db=sqlite3.connect(str(Path(td)/'reference.sqlite'))
        try:
            db.execute('CREATE TABLE original (sha256 TEXT PRIMARY KEY, record TEXT NOT NULL, details TEXT NOT NULL) WITHOUT ROWID')
            batch=[]; old_count=0
            for record,detail in shards(old):
                batch.append((record[0],json.dumps(record,ensure_ascii=False,sort_keys=True),
                              json.dumps(detail,ensure_ascii=False,sort_keys=True)))
                old_count+=1
                if len(batch)>=10000:
                    db.executemany('INSERT INTO original VALUES (?,?,?)',batch);batch.clear()
            if batch: db.executemany('INSERT INTO original VALUES (?,?,?)',batch)
            db.commit()
            with mini.open('r',encoding='utf-8-sig',newline='') as f:
                additions={row['sha256'].lower():(row['sha1'].lower(),int(row['size_bytes']),row['crc32'].lower())
                           for row in csv.DictReader(f)}
            if len(additions)!=expected_mini: raise ValueError('Unexpected mini CSV SHA-256 count')
            extras=preserved=0
            for record,detail in shards(new):
                saved=db.execute('SELECT record,details FROM original WHERE sha256=?',(record[0],)).fetchone()
                if saved:
                    if (json.loads(saved[0])!=record or json.loads(saved[1])!=detail):
                        raise ValueError('Old record or manifest data changed: '+record[0])
                    db.execute('DELETE FROM original WHERE sha256=?',(record[0],))
                    preserved+=1
                else:
                    known=additions.pop(record[0],None)
                    if known is None: raise ValueError('Unexpected new SHA-256 '+record[0])
                    if (record[1],record[2])!=(known[0],known[1]):
                        raise ValueError('Mini hash or byte size mismatch: '+record[0])
                    if (len(record[3])!=1 or record[3][0][0]!=2 or
                            record[3][0][3].lower()!=known[2] or
                            len(detail)!=1 or detail[0][0]!=2):
                        raise ValueError('Mini source or details malformed: '+record[0])
                    extras+=1
                if (preserved+extras)%100000==0:
                    print(f'Verified {preserved+extras:,} records...',flush=True)
            if db.execute('SELECT 1 FROM original LIMIT 1').fetchone():
                raise ValueError('Some old records are missing')
            if additions: raise ValueError(f'{len(additions)} mini files missing from candidate')
            if (preserved,extras)!=(expected_old,expected_mini):
                raise ValueError(f'Count mismatch: old={preserved}, mini={extras}')
            print(f'VERIFIED: all {preserved:,} old records/details preserved exactly; '
                  f'all {extras:,} mini SHA-1/SHA-256/size/CRC32 values present.')
        finally:db.close()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--old-data',required=True,type=Path)
    p.add_argument('--new-data',required=True,type=Path)
    p.add_argument('--mini-csv',required=True,type=Path)
    p.add_argument('--expected-old', type=int, default=620287)
    p.add_argument('--expected-new', type=int, default=621715)
    p.add_argument('--expected-rows', type=int, default=817643)
    p.add_argument('--expected-mini', type=int, default=1428)
    a=p.parse_args()
    try: verify(a.old_data,a.new_data,a.mini_csv, a.expected_old, a.expected_new,
                a.expected_rows, a.expected_mini)
    except (ValueError,OSError,KeyError,sqlite3.Error,json.JSONDecodeError,csv.Error) as e:
        print(f'VERIFICATION FAILED: {e}',file=sys.stderr);return 1
    return 0
if __name__=='__main__': sys.exit(main())
