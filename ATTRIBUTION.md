# Attribution and technical references

## Downloader implementation

`jarchive_download.py` was developed for the independent J2ME archive search project with substantial ChatGPT assistance and tested against real archive members. The current distributed Python script **does not vendor or import Python code from third-party LZMA/7z projects**, and it does not embed a third-party LZMA2 decoder. It uses the Python standard-library `lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[...])` interface to the system's LZMA library, Python's other standard-library modules, and the installed `curl` command.

Technical documentation and existing implementations are valuable **references**, not necessarily code sources. We should not claim code was copied from a repository merely because it helped explain the file format. Conversely, if earlier or future versions incorporate third-party source directly, the relevant license, copyright notices, and exact attribution must be reviewed and preserved before distribution.

## Relevant projects, documentation and acknowledgments

- **LZMA/LZMA2 and 7z format:** Igor Pavlov, [7-Zip and LZMA SDK](https://www.7-zip.org/sdk.html). This format and its reset semantics enable range-based extraction. This project does not bundle 7-Zip or LZMA SDK code.
- **Python LZMA API:** [Python `lzma` documentation](https://docs.python.org/3/library/lzma.html), including raw streams and `FILTER_LZMA2`. This relies on the Python installation's LZMA support, commonly based on **liblzma** from XZ Utils.
- **LZMA2 control-byte reference:** [Linux XZ/LZMA2 decoder source](https://github.com/torvalds/linux/blob/master/lib/xz/xz_dec_lzma2.c), particularly the distinction between control byte `0x01` (uncompressed dictionary reset) and `0xE0`–`0xFF` (compressed dictionary resets). It is cited as an explanatory reference, **not incorporated source**.
- **HTTP byte-range transport:** [`curl`](https://curl.se/) (a separately installed command-line tool); no curl library is bundled in this repository.
- **Original archive:** [TwoSpacesSG's New J2ME Software Archive](https://archive.org/details/96x65pixels_j2me), served by the [Internet Archive](https://archive.org/). The source archives and game files are not created, owned, or licensed by this downloader project.

## Rights and distribution

The script's source, the archive index data, third-party reference implementations, and the original JAR contents are **different things**. Do not infer that the license of this project's script grants permission to copy or redistribute archived games or to relicense external decoder implementations.

Before announcing a reusable open-source software license for this repository, choose an explicit license and review the final source tree for any code actually copied from outside projects. The acknowledgments above are accurate descriptions of the inspected standalone downloader, **not a substitute for a source-level license audit of every other file**.
