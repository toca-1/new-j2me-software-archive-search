#!/usr/bin/env python3
"""Download selected J2ME archive volumes and recover a specific indexed file.

For the Internet Archive item j2me-archive-unified-2019-09 only.
The archive is a 43-volume split 7z; 001 is published inside a .zip wrapper.
The verified partial-extraction technique preserves the volume layout with
sparse placeholder files, while downloading only the volumes in --parts.

Example (from a verified block-18 test):
  python3 j2me_fetch.py \
    --parts 001,010,011,043 \
    --path 'dertz.in/dls/01269-3D DOOM-3.jar' \
    --sha1 d2e3d085d25a80515a2527ef499a1025f5cd837e

Requirements: Linux or another POSIX OS, 7z, and curl or wget.
Always obtain --parts and --sha1 from the same trusted index row.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import zipfile

ARCHIVE_ID = 'j2me-archive-unified-2019-09'
PREFIX = ARCHIVE_ID + '.7z.'
BASE_URL = 'https://archive.org/download/' + ARCHIVE_ID + '/'
FULL_VOLUME_SIZE = 2_147_483_648
LAST_VOLUME_SIZE = 52_151_181
NUM_PARTS = 43
SHA1_RE = re.compile(r'^[0-9a-fA-F]{40}$')


def parse_parts(raw: str) -> list[int]:
    fields = [s.strip() for s in raw.split(',')]
    if not fields or any(not f.isdigit() for f in fields):
        raise ValueError('Parts must be comma-separated numbers, e.g. 001,010,011,043')
    parts = sorted(set(int(f) for f in fields))
    if any(x < 1 or x > NUM_PARTS for x in parts):
        raise ValueError('Part numbers must be between 001 and 043')
    if 1 not in parts or 43 not in parts:
        raise ValueError('Required parts must include 001 and 043 (archive metadata)')
    return parts


def parse_archive_path(raw: str) -> Path:
    if '\\' in raw or '\x00' in raw or '\r' in raw or '\n' in raw:
        raise ValueError('Unsupported characters in archive path')
    posix = PurePosixPath(raw)
    if not raw or posix.is_absolute() or any(x in ('..', '.') for x in raw.split('/')):
        raise ValueError('Archive path must be a safe, relative path')
    if any(not x for x in raw.split('/')) or ':' in posix.parts[0]:
        raise ValueError('Unsupported archive path')
    return Path(*posix.parts)


def download(url: str, destination: Path) -> None:
    if destination.is_file():
        print(f'Checking existing download: {destination.name}', flush=True)
    else:
        print(f'Downloading: {destination.name}', flush=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if shutil.which('curl'):
        cmd = ['curl', '--location', '--fail', '--show-error',
               '--retry', '6', '--retry-delay', '2', '--retry-all-errors',
               '--continue-at', '-', '--output', str(destination), url]
    elif shutil.which('wget'):
        cmd = ['wget', '--continue', '--output-document', str(destination), url]
    else:
        raise RuntimeError('curl or wget required; e.g. sudo apt install curl')
    subprocess.run(cmd, check=True)


def extract_first_zip(zip_path: Path, extracted_part: Path) -> None:
    if extracted_part.exists() and extracted_part.stat().st_size == FULL_VOLUME_SIZE:
        print('Part 001 is already unwrapped.', flush=True)
        return
    tmp = extracted_part.with_name(extracted_part.name + '.tmp')
    try:
        print('Unwrapping the 2 GiB first volume from .001.zip...', flush=True)
        with zipfile.ZipFile(zip_path) as zf:
            matches = [info for info in zf.infolist()
                       if not info.is_dir() and PurePosixPath(info.filename).name == extracted_part.name]
            if len(matches) != 1:
                raise ValueError('The ZIP wrapper does not contain exactly one expected .7z.001')
            member = matches[0]
            if member.file_size != FULL_VOLUME_SIZE:
                raise ValueError(f'Unexpected uncompressed 001 size: {member.file_size}')
            with zf.open(member, 'r') as source, tmp.open('wb') as out:
                shutil.copyfileobj(source, out, length=4 * 1024 * 1024)
        if tmp.stat().st_size != FULL_VOLUME_SIZE:
            raise IOError('Extracted part 001 has an incorrect size')
        tmp.replace(extracted_part)
    finally:
        if tmp.exists():
            tmp.unlink()


def fetch_required(parts: list[int], downloads: Path, skip_download: bool) -> None:
    downloads.mkdir(parents=True, exist_ok=True)
    for i in parts:
        suffix = f'{i:03d}'
        base_name = PREFIX + suffix
        filename = base_name + '.zip' if i == 1 else base_name
        downloaded = downloads / filename
        expected_size = FULL_VOLUME_SIZE if i < NUM_PARTS else LAST_VOLUME_SIZE
        local_part = downloads / base_name
        if i == 1 and local_part.is_file() and local_part.stat().st_size == FULL_VOLUME_SIZE:
            print('Using existing unwrapped part 001.', flush=True)
            continue
        if i != 1 and local_part.is_file() and local_part.stat().st_size == expected_size:
            print(f'Using existing part {suffix}.', flush=True)
            continue
        if not skip_download:
            download(BASE_URL + filename, downloaded)
        if not downloaded.is_file():
            raise FileNotFoundError(f'Required download missing: {downloaded}')
        if i == 1:
            extract_first_zip(downloaded, local_part)
        elif downloaded.stat().st_size != expected_size:
            raise IOError(f'Part {suffix} has {downloaded.stat().st_size:,} bytes, '
                          f'expected {expected_size:,}; rerun to resume the download')


def make_volume_set(parts: list[int], downloads: Path, volume_dir: Path) -> None:
    volume_dir.mkdir(parents=True, exist_ok=True)
    # Note: this directory is dedicated to the program. Do not overwrite files.
    for i in range(1, NUM_PARTS + 1):
        name = PREFIX + f'{i:03d}'
        target = volume_dir / name
        if target.exists() or target.is_symlink():
            target.unlink()
        if i in parts:
            original = (downloads / name).resolve(strict=True)
            target.symlink_to(original)
        else:
            # All missing volumes must have the same *logical* size as the
            # originals. truncate() is sparse on Linux: no 2 GiB allocation.
            with target.open('wb') as f:
                f.truncate(FULL_VOLUME_SIZE)
    print(f'Prepared {NUM_PARTS} logical volumes: {len(parts)} real, '
          f'{NUM_PARTS-len(parts)} sparse placeholders.', flush=True)


def extract_and_verify(volume_dir: Path, archive_path: str, relative_path: Path,
                       expected_sha1: str, destination_root: Path) -> Path:
    result_path = destination_root / relative_path
    result_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = result_path.with_name(result_path.name + '.partial')
    first_part = volume_dir / (PREFIX + '001')
    digest = hashlib.sha1()
    total = 0
    log_path = volume_dir.parent / '7z-stderr.log'
    try:
        print(f'Extracting: {archive_path}', flush=True)
        with temp_path.open('wb') as out, log_path.open('wb') as diagnostics:
            proc = subprocess.Popen(['7z', 'x', '-so', '-bd', '-spd', '-y', str(first_part), '--', archive_path],
                                    stdout=subprocess.PIPE, stderr=diagnostics)
            assert proc.stdout is not None
            for chunk in iter(lambda: proc.stdout.read(4 * 1024 * 1024), b''):
                digest.update(chunk)
                total += len(chunk)
                out.write(chunk)
            proc.stdout.close()
            status = proc.wait()
        if status:
            raise RuntimeError(f'7z failed with code {status}; see {log_path}')
        actual_sha1 = digest.hexdigest()
        if actual_sha1.lower() != expected_sha1.lower():
            raise ValueError(f'SHA-1 mismatch for {archive_path}: got {actual_sha1}, '
                             f'expected {expected_sha1}. Check parts and downloaded bytes.')
        temp_path.replace(result_path)
        print(f'SUCCESS: SHA-1 verified ({actual_sha1}), size {total:,} bytes.', flush=True)
        print(f'File saved to: {result_path.resolve()}', flush=True)
        return result_path
    finally:
        if temp_path.exists():
            temp_path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--parts', required=True, help='From website required_parts, e.g. 001,010,011,043')
    parser.add_argument('--path', required=True, help='Exact archive_path from website, in quotes')
    parser.add_argument('--sha1', required=True, help='Expected SHA-1 from website')
    parser.add_argument('--directory', type=Path, default=Path('./j2me-recovery'),
                        help='Working directory for downloads, placeholders, and output')
    parser.add_argument('--skip-download', action='store_true',
                        help='Use already downloaded volumes in DIRECTORY/downloads')
    args = parser.parse_args()
    if not SHA1_RE.fullmatch(args.sha1):
        parser.error('--sha1 must be a 40-character hexadecimal SHA-1')
    try:
        parts = parse_parts(args.parts)
        relative = parse_archive_path(args.path)
    except ValueError as e:
        parser.error(str(e))
    if not shutil.which('7z'):
        parser.error('7z not installed; sudo apt install 7zip')
    home = args.directory.expanduser().resolve()
    downloads = home / 'downloads'
    volume_dir = home / 'volumes'
    output_root = home / 'recovered'
    try:
        fetch_required(parts, downloads, args.skip_download)
        make_volume_set(parts, downloads, volume_dir)
        extract_and_verify(volume_dir, args.path, relative, args.sha1.lower(), output_root)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError, zipfile.BadZipFile) as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
