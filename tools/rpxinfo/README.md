# tools/rpxinfo

`rpxinfo` is an original, dependency-free Node.js CLI to inspect **Wii U
RPX/RPL executables** — the format of the game's main binary (`U-King.rpx`).

It reads the ELF header, the section table, decompresses sections flagged
`SHF_RPL_ZLIB` (`0x08000000`, layout: `u32be uncompressed size` + zlib
stream), and maps runtime addresses back to sections.

It never modifies the file it inspects and contains no game content.

## Usage

```bash
node rpxinfo.js info  "<your dump>/code/U-King.rpx"
node rpxinfo.js info  "<your dump>/code/U-King.rpx" --json
node rpxinfo.js dump  "<your dump>/code/U-King.rpx" .text --out text.bin
node rpxinfo.js addr  "<your dump>/code/U-King.rpx" 0x03C70404
```

Keep `--out` dumps local — extracted data stays off this repository.

## Tests

```bash
npm test    # node --test
```

The fixture builder (`tests/fixture.js`) generates a synthetic RPX from
scratch; the test suite never touches game data.

## Background

RPX/RPL are modified ELF32 big-endian objects: no program headers (sections
are loaded directly), some sections are zlib-compressed, and dynamic-linking
imports/exports live in dedicated sections. Public reference:
<https://wiiubrew.org/wiki/RPL>.
