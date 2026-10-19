"use strict";

/**
 * Decode cross-check: compare this decoder's mnemonic output against an
 * external PowerPC disassembler dump (rizin, driven through REA). The tool is
 * deliberately dump-based: no external process is spawned from here, the dump
 * is produced separately and passed in.
 *
 * The dump format is the plain text of rizin's `pd <count> @ <offset>` with
 * `e io.va=false` (addresses are file offsets of the decompressed `.text`) and
 * `e asm.pseudo=false; e asm.bytes=false; e asm.lines=false` (one instruction
 * per line, canonical mnemonics). See tools/ppcx/xcheck.js for the exact
 * commands.
 *
 * What the comparison proves: agreement is *mnemonic-level*. rizin keeps
 * several assembler aliases even with pseudo-instructions off (`mr` for `or`,
 * `li` for `addi`, `slwi`/`clrlwi` for `rlwinm`, `mtlr` for `mtspr`,
 * `btlr`/`bflr` for `bclr`, `trap`/`twu`/`tweq` for `tw`, ...), so both sides
 * are normalized onto the name this decoder uses. Operand fields are not
 * compared here; they are covered by the differential ISA harness
 * (tests/isa) and the runtime tests.
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

const { decode } = require("./decode.js");

/**
 * Assembler extended mnemonics (rizin side) mapped onto this decoder's
 * canonical names. Every entry is a documented PowerPC assembler alias of the
 * same encoding, not a different instruction.
 */
const ALIASES = {
    // immediate forms
    li: "addi",
    lis: "addis",
    la: "addi",
    nop: "ori",
    // subtract / logical de-sugared forms
    sub: "subf",
    subc: "subfc",
    sube: "subfe",
    subme: "subfme",
    subze: "subfze",
    mr: "or",
    not: "nor",
    // SPR aliases
    mtlr: "mtspr",
    mtctr: "mtspr",
    mtxer: "mtspr",
    mflr: "mfspr",
    mfctr: "mfspr",
    mfxer: "mfspr",
    // compares of CR0
    cmpwi: "cmpi",
    cmplwi: "cmpli",
    cmpw: "cmp",
    cmplw: "cmpl",
    cmpd: "cmp",
    cmpld: "cmpl",
    // rotates
    slwi: "rlwinm",
    srwi: "rlwinm",
    clrlwi: "rlwinm",
    clrrwi: "rlwinm",
    rotlwi: "rlwinm",
    rotrwi: "rlwinm",
    extlwi: "rlwinm",
    extrwi: "rlwinm",
    clrlslwi: "rlwinm",
    inslwi: "rlwimi",
    insrwi: "rlwimi",
    rotlw: "rlwnm",
    // condition-register aliases
    crclr: "crxor",
    crset: "creqv",
    crmove: "cror",
    crnot: "crnor",
    // branch aliases
    blr: "bclr",
    bflr: "bclr",
    btlr: "bclr",
    bdnzl: "bclr",
    bdzl: "bclr",
    bdnz: "bclr",
    bdz: "bclr",
    bfl: "bcl",
    btl: "bcl",
    bctr: "bcctr",
    bctrl: "bcctr",
    bt: "bc",
    bf: "bc",
    beq: "bc",
    bne: "bc",
    blt: "bc",
    bge: "bc",
    bgt: "bc",
    ble: "bc",
    bso: "bc",
    bns: "bc",
    // traps: rizin aliases the unconditional form with operands as `twu`
    // and the TO-field forms as tweq/twne/twgt/twlt/twllt/...
    trap: "tw",
    twu: "tw",
    tweq: "tw",
    twne: "tw",
    twgt: "tw",
    twlt: "tw",
    twllt: "tw",
    twlgt: "tw",
    twlne: "tw",
    twlle: "tw",
    twlge: "tw",
};

/**
 * Normalizes a mnemonic: lowercase, record suffix separated, alias resolved.
 * `lhzux` and `lhzux.` therefore compare equal after mapping, while keeping
 * the suffix available for a strict suffix check.
 */
function normalize(name) {
    let base = name.toLowerCase();
    let dot = "";
    while (base.endsWith(".")) {
        dot += ".";
        base = base.slice(0, -1);
    }
    return { base: ALIASES[base] || base, dot };
}

/**
 * Compares one decompressed `.text` buffer against a list of rizin dumps.
 *
 * `dumps` entries are `{ name, text }`, where `name` matches `rizin-NNN.txt`
 * and `NNN` is the chunk index: the dump covers words
 * `[NNN * chunk, NNN * chunk + chunk)` and the first occurrence of an offset
 * wins (rizin's `>` redirection does not truncate, so regenerating a shorter
 * dump over a longer one leaves stale lines at the end).
 *
 * Returns a report object: counts per class, the observed classes with
 * counts, and a few examples per class for triage.
 */
function compareDumps({ text, dumps, chunk = 262144 }) {
    const total = Math.floor(text.length / 4);
    const rizin = new Array(total);
    const parse = { lines: 0, duplicates: 0, outOfRange: 0, continuations: 0 };

    for (const dump of dumps) {
        const m = dump.name.match(/(\d+)\.txt$/);
        if (!m) throw new Error(`dump file name does not carry a chunk index: ${dump.name}`);
        const index = parseInt(m[1], 10);
        const lo = index * chunk;
        const hi = lo + Math.min(chunk, total - lo);
        for (const rawLine of dump.text.split(/\r?\n/)) {
            if (rawLine.length === 0) continue;
            const line = rawLine.match(/^0x([0-9a-fA-F]+)\s+(\S+)(.*)$/);
            if (!line) {
                parse.continuations++;
                continue;
            }
            parse.lines++;
            const word = parseInt(line[1], 16) / 4;
            if (word < lo || word >= hi) {
                parse.outOfRange++;
                continue;
            }
            if (rizin[word] !== undefined) {
                parse.duplicates++;
                continue;
            }
            rizin[word] = { name: line[2], operands: line[3].trim() };
        }
    }

    const classes = {
        alias: new Map(),
        mismatch: new Map(),
        overlap: new Map(),
        undecoded: new Map(),
        rizinInvalid: new Map(),
    };
    const examples = { alias: [], mismatch: [], overlap: [], undecoded: [], rizinInvalid: [] };
    const counts = {
        words: total,
        equal: 0,
        alias: 0,
        mismatch: 0,
        overlap: 0,
        suffixMismatch: 0,
        undecoded: 0,
        rizinInvalid: 0,
        missing: 0,
    };

    const note = (bucket, cls, word) => {
        classes[bucket].set(cls, (classes[bucket].get(cls) || 0) + 1);
        if (examples[bucket].length < 8) examples[bucket].push({ word, cls });
    };

    for (let i = 0; i < total; i++) {
        const ins = decode(text.readUInt32BE(i * 4));
        const ourName = ins.name + (ins.rc && !ins.name.endsWith(".") ? "." : "");
        const other = rizin[i];
        if (!other) {
            counts.missing++;
            continue;
        }
        if (ins.supported === false) {
            counts.undecoded++;
            note("undecoded", `${ourName} => ${other.name}`, i);
            continue;
        }
        if (other.name === "invalid") {
            counts.rizinInvalid++;
            note("rizinInvalid", `${ourName} => invalid`, i);
            continue;
        }
        const ours = normalize(ourName);
        const theirs = normalize(other.name);
        if (ourName.toLowerCase() === other.name.toLowerCase()) {
            counts.equal++;
        } else if (ours.base === theirs.base) {
            if (ours.dot === theirs.dot) {
                counts.alias++;
                note("alias", `${ourName} => ${other.name}`, i);
            } else {
                counts.suffixMismatch++;
                note("mismatch", `${ourName} => ${other.name}`, i);
            }
        } else if (ourName.toLowerCase().startsWith("ps") && !theirs.base.startsWith("ps")) {
            /* Paired-single encodings overlap AltiVec/VSX opcodes; the Wii U
             * CPU (Espresso) has no AltiVec, so this decoder reads them as PS
             * when rizin's CPU model picks the other interpretation. */
            counts.overlap++;
            note("overlap", `${ourName} => ${other.name}`, i);
        } else {
            counts.mismatch++;
            note("mismatch", `${ourName} => ${other.name}`, i);
        }
    }

    const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([cls, count]) => ({ cls, count }));
    return {
        counts,
        parse,
        classes: {
            alias: sorted(classes.alias),
            mismatch: sorted(classes.mismatch),
            overlap: sorted(classes.overlap),
            undecoded: sorted(classes.undecoded),
            rizinInvalid: sorted(classes.rizinInvalid),
        },
        examples,
    };
}

module.exports = { compareDumps, ALIASES, normalize };
