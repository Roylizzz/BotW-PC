# REA, Ghidra and PowerPC RPX analysis workflow

REA is an evidence-oriented reverse-engineering CLI/MCP, not a Wii U-to-PC port generator. Its experimental Ghidra Windows P0 admission excludes PowerPC Wii U RPX. **For U-King.rpx on Windows use direct Ghidra 12.1.x headless + an RPX/RPL loader extension**, plus local rpxinfo/ppcx. Do not treat REA connectivity as proof that Ghidra can analyze this binary through REA.

## Recommended sequence

1. Record local legally obtained game update version/entry and SHA-256 (never upload it).
2. Inspect structurally with rpxinfo; reject corrupt headers/sections/relocations.
3. Use native Ghidra headless and tools/ghidra-scripts; repair primary imports as the loader requires. Preserve research as minimal observations, offsets and contracts rather than decompiler output.
4. Use REA only for admitted targets and adjacent evidence capture. Verify current provider/host/format admission before enabling a particular REA analysis lane.
5. Cross-check assumptions against independent ISA references, synthetic tests and runtime traces; report observed, derived, hypothesized and unknown separately.
6. Keep Ghidra databases, extracted content, disassembly, local symbol datasets and generated code out of Git.

## Evidence record

Date, tool version, source version/digest locally, target CPU/ABI, provider, address/section, evidence identifier if applicable, what was observed, alternatives/uncertainty, reproducible steps and behavioral confirmation.

Links: [REA Windows P0](https://github.com/morluto/rea/blob/main/docs/windows-ghidra-p0.md), [REA providers](https://github.com/morluto/rea/blob/main/docs/ghidra-provider.md), [REA installation](https://github.com/morluto/rea/blob/main/docs/installation.md), [current workstation toolchain](environment.md).
