#!/usr/bin/env node
"use strict";

/**
 * xcheck - compare this decoder against an external PowerPC disassembler.
 *
 * The dump is produced out-of-band by rizin (through REA on Windows, where the
 * Ghidra lane does not take PowerPC RPX files):
 *
 *   1. decompress the RPX `.text` section to a flat file (word 0 = text base);
 *   2. for every chunk index NNN of `chunk` words (default 262144):
 *
 *      rizin -q \
 *        -c 'e asm.arch=ppc; e asm.bits=32; e asm.cpu=ps; e cfg.bigendian=true;
 *            e asm.pseudo=false; e asm.bytes=false; e asm.lines=false;
 *            e asm.comments=false; e io.va=false;
 *            pd <chunk> @ <NNN * chunk * 4>' \
 *        text.bin > dumps/rizin-NNN.txt
 *
 * `asm.cpu=ps` selects the Cell PPU model, the only rizin CPU model that
 * decodes the paired-single instructions this target uses. With
 * `io.va=false` the addresses in the dump are plain file offsets.
 *
 * Note: rizin's `>` redirection does not truncate. Delete the dump files
 * before regenerating them, otherwise shorter dumps keep stale lines at the
 * end (the comparison ignores lines outside a file's own word range, but the
 * stale tail of an older dump would silently hide nothing — it is simply
 * wasted work).
 *
 * Every difference is bucketed:
 *   equal            the canonical mnemonics match
 *   alias            same encoding, different assembler mnemonic (a documented
 *                    extended mnemonic: `li`/`addi`, `mr`/`or`, `slwi`/`rlwinm`)
 *   overlap          paired-single vs AltiVec/VSX decoding of the same opcode
 *   suffix-mismatch  same base mnemonic but a different record-bit suffix
 *   mismatch         a real disagreement (the gate: exit code 1)
 *   undecoded        this decoder reports the instruction as unsupported
 *   rizinInvalid     rizin cannot decode a word this decoder supports
 *   missing          no dump line for a word
 *
 * Exit code: 0 when there is no mismatch/missing word, 1 otherwise.
 */

const fs = require("node:fs");
const path = require("node:path");

const { compareDumps } = require("./lib/xcheck.js");

const USAGE = `xcheck - compare the ppcx decoder against a disassembler dump

Usage: node xcheck.js --text <file> [--dumps <dir>] [--chunk N] [--top N] [--json <file>]

  --text   decompressed .text image (4-byte big-endian words, word 0 first)
  --dumps  directory with rizin-NNN.txt dumps (default: build/xcheck)
  --chunk  words per dump file (default: 262144)
  --top    classes to list per bucket (default: 40)
  --json   write the full report as JSON

See the header of this file for the rizin commands that produce the dumps.
`;

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                out[key] = next;
                i++;
            } else {
                out[key] = "true";
            }
        } else {
            out._.push(a);
        }
    }
    return out;
}

function fail(msg) {
    console.error(`xcheck: ${msg}`);
    process.exit(2);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help !== undefined || args.text === undefined) {
        console.log(USAGE);
        process.exit(args.text === undefined ? 2 : 0);
    }

    const dumpsDir = args.dumps !== undefined ? args.dumps : "build/xcheck";
    const chunk = args.chunk !== undefined ? Number(args.chunk) : 262144;
    const top = args.top !== undefined ? Number(args.top) : 40;
    if (!Number.isFinite(chunk) || chunk <= 0) fail(`invalid --chunk: ${args.chunk}`);

    const text = fs.readFileSync(args.text);
    const dumps = fs
        .readdirSync(dumpsDir)
        .filter((f) => /^rizin-\d+\.txt$/.test(f))
        .sort()
        .map((f) => ({ name: f, text: fs.readFileSync(path.join(dumpsDir, f), "utf8") }));
    if (dumps.length === 0) fail(`no rizin-NNN.txt dumps in ${dumpsDir}`);

    const report = compareDumps({ text, dumps, chunk });
    const { counts, parse, classes } = report;
    const pct = (n) => ((n / counts.words) * 100).toFixed(4);

    console.log(`xcheck: ${dumps.length} dump file(s), ${counts.words} words (chunk ${chunk})`);
    console.log(
        `dump lines: ${parse.lines} parsed, ${parse.continuations} continuation(s), ` +
            `${parse.duplicates} duplicate(s), ${parse.outOfRange} out-of-range line(s) ignored`
    );
    console.log(`  equal           ${String(counts.equal).padStart(9)} (${pct(counts.equal)}%)`);
    console.log(`  alias           ${String(counts.alias).padStart(9)} (${pct(counts.alias)}%)`);
    console.log(`  overlap         ${String(counts.overlap).padStart(9)} (${pct(counts.overlap)}%)`);
    console.log(`  suffix mismatch ${String(counts.suffixMismatch).padStart(9)}`);
    console.log(`  mismatch        ${String(counts.mismatch).padStart(9)}`);
    console.log(`  undecoded       ${String(counts.undecoded).padStart(9)}`);
    console.log(`  rizin invalid   ${String(counts.rizinInvalid).padStart(9)}`);
    console.log(`  missing         ${String(counts.missing).padStart(9)}`);

    const list = (title, rows) => {
        if (rows.length === 0) return;
        console.log(`\n${title}:`);
        for (const row of rows.slice(0, top)) console.log(`  ${String(row.count).padStart(8)}  ${row.cls}`);
    };
    list("alias classes", classes.alias);
    list("mismatch classes", classes.mismatch);
    list("overlap classes", classes.overlap);
    list("undecoded classes", classes.undecoded);
    list("words rizin cannot decode", classes.rizinInvalid);

    if (args.json !== undefined) {
        fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
        console.log(`\nreport: ${args.json}`);
    }

    const bad = counts.mismatch + counts.suffixMismatch + counts.missing;
    if (bad > 0) {
        console.error(`\nxcheck: ${bad} disagreement(s) — inspect the classes above`);
        process.exit(1);
    }
    const ok = counts.equal + counts.alias + counts.overlap + counts.undecoded + counts.rizinInvalid;
    if (ok !== counts.words) fail(`classification lost words: ${ok} of ${counts.words}`);
    console.log("\nxcheck: OK, mnemonic-level agreement (aliases mapped)");
}

main();
