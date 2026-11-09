# Attribution and technical references

## Downloader implementation

`jarchive_download.py` was developed for the independent J2ME archive search project with substantial ChatGPT assistance and tested against real archive files. The current distributed Python script does not vendor or import Python code from third-party LZMA/7z projects, and it does not embed a third-party LZMA2 decoder. It uses the Python standard-library `lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[...])` interface to the system's LZMA library, Python's other standard-library modules, and the installed `curl` command.

## Relevant projects, documentation and acknowledgments

- *LZMA/LZMA2 and 7z format:* Igor Pavlov, [7-Zip and LZMA SDK](https://www.7-zip.org/sdk.html). This format and its reset semantics enable range-based extraction. The present project does not bundle 7-Zip or LZMA SDK code
- *Python LZMA API:* [Python `lzma` documentation](https://docs.python.org/3/library/lzma.html), including raw streams and `FILTER_LZMA2`. This relies on the Python installation's LZMA support, commonly based on **liblzma** from XZ Utils
- *LZMA2 control-byte reference:* [Linux XZ/LZMA2 decoder source](https://github.com/torvalds/linux/blob/master/lib/xz/xz_dec_lzma2.c) (explanatory reference), particularly the distinction between control byte `0x01` (uncompressed dictionary reset) and `0xE0`–`0xFF` (compressed dictionary resets)
- *HTTP byte-range transport:* [`curl`](https://curl.se/) (a separately installed command-line tool); no curl library is bundled in this repository
- *Original archive:* [TwoSpacesSG's New J2ME Software Archive](https://archive.org/details/96x65pixels_j2me), served by the [Internet Archive](https://archive.org/). The source archives and game files are not created, owned, or licensed by this downloader project

## Rights and distribution

The license of this project's script does not grant permission to copy or redistribute archived games or to relicense external decoder implementations. The acknowledgments above describe the standalone downloader’s implementation and technical references.
