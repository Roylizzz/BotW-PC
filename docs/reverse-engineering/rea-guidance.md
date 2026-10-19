# REA, Ghidra and PowerPC RPX analysis workflow

REA is an evidence-oriented reverse-engineering CLI/MCP, not a Wii U-to-PC port generator. Its experimental Ghidra Windows P0 admission excludes PowerPC Wii U RPX. **For U-King.rpx on Windows use direct Ghidra 12.1.x headless + an RPX/RPL loader extension**, plus local rpxinfo/ppcx. Do not treat REA connectivity as proof that Ghidra can analyze this binary through REA. (Measured 2026-10-18 on v208: REA accepts the file identity but every candidate provider rejects the target — `ghidra` `target_format_unsupported`, `hopper` `architecture_unsupported`, `ida` `not_configured`; the direct headless path is verified working.) The rizin lane is different: it decodes a flat `.text` dump and is the independent disassembler behind the decoder cross-check (see *Rizin lane* below).

## Rizin lane for PowerPC `.text` on Windows (measured 2026-10-19)

REA's Ghidra provider rejects the RPX, but `tools.rea.execute_rizin_command`
(rizin) decodes the PowerPC code once the section is flat. This is the
independent-disassembly lane used for the decode cross-check; it does not
replace the Ghidra headless path for function structure.

1. Decompress `.text` to a flat file (the RPX stores it zlib-compressed;
   `tools/rpxinfo` exposes the section). Word 0 of the dump is the section
   base, so `file offset = VA - text_addr` (`0x02000020` on v208).
2. Run rizin with the Cell PPU CPU model, one chunk per `pd` command and a
   redirect to a dump file:

   ```
   e asm.arch=ppc; e asm.bits=32; e asm.cpu=ps; e cfg.bigendian=true;
   e asm.pseudo=false; e asm.bytes=false; e asm.lines=false;
   e asm.comments=false; e io.va=false;
   pd 262144 @ <chunk * 262144 * 4>
   ```

3. Compare with `node tools/ppcx/xcheck.js --text <flat .text> --dumps <dir>`.

Gotchas measured on v208:

- `asm.cpu=ps` is required: the default CPU model decodes the paired-single
  opcodes as AltiVec/VSX (`psq_l` as `lq`, `ps_mul*` as `vmhaddshs`, ...),
  while `psq_*` is what this target executes (Espresso has no AltiVec).
- Rizin's `>` redirection does **not** truncate: delete the dump files before
  regenerating, otherwise a shorter dump keeps the stale tail of the previous
  one (the comparison ignores out-of-range lines, but the parser must be
  first-occurrence-wins).
- `io.va=false` makes the printed addresses file offsets of the flat dump,
  which is what `xcheck` expects.
- `pd` prints one line per instruction but wraps long operand lists; those
  continuation lines must not be parsed as instructions.
- ~16 s per 262,144-word chunk through REA; 36 chunks cover the 36,994,060
  bytes of the v208 `.text` (9,248,515 words).

Measured result (2026-10-19): 63.1852% identical mnemonics, 36.8142%
documented assembler aliases, **0 real disagreements** and the same 53
data/illegal words rejected by both sides. The cross-check found the
`lhzux`/`lhaux` (XO 311/375) defect documented in
[the audit](../audits/2026-10-18-code-audit.md).

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
