"use strict";

/**
 * Function-boundary discovery and instruction-coverage analysis for RPX
 * code (PowerPC, big-endian).
 *
 * Strategy (first iteration, deliberately conservative):
 *
 *   1. every `bl` target inside .text is a function start;
 *   2. a word that looks like a prologue (`stwu r1,-N(r1)` / `mflr r0` /
 *      `stmw`) directly after a control-flow boundary (return or branch)
 *      is a function start;
 *   3. .text begins with a function;
 *   4. a u32 in .rodata that an ADDR32 relocation patches to point into
 *      .text is a code pointer; its target is reported separately as a
 *      `pointerStart` (vtables, callback tables and tiny constant getters
 *      that no branch scan can reach).
 *
 * Ranges are then [start_i, start_{i+1}), which is exact when the
 * discovery found every start and approximate otherwise (jump tables and
 * pointer-only functions are invisible to a branch scan — the local Ghidra
 * census is used to measure the overlap in the research notes).
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

const { decode, LI_SIGN } = require("./decode.js");
const rpxlib = require("../../rpxinfo/lib/rpx.js");

const MFLR_R0 = 0x7c0802a6;
const BLR = 0x4e800020;
const BCTR = 0x4e800420;
const STMW_OP = 47;

function isBoundaryWord(word) {
    if (word === BLR || word === BCTR) return true;
    const op = (word >>> 26) & 0x3f;
    return op === 16 || op === 18 || op === 19;
}

function looksLikePrologue(word) {
    if (word === MFLR_R0) return true;
    const op = (word >>> 26) & 0x3f;
    const rt = (word >>> 21) & 0x1f;
    const ra = (word >>> 16) & 0x1f;
    if (op === 37 && rt === 1 && ra === 1) return true; // stwu r1,-N(r1)
    if (op === STMW_OP && ra === 1) return true; // stmw rN,-M(r1)
    return false;
}

/**
 * Code pointers stored in `.rodata` and `.data`: the u32 values that ADDR32
 * relocations patch so they point into .text. These are table entries
 * (vtables, callback tables, tiny constant getters) reachable from data
 * only; e.g. v208 `FUN_031FA4CC` (the GraphicsSystem method at vtable+0x5C)
 * is one. `.data` carries the same kind of patched pointers (static init
 * tables), so both relocation sections are scanned. Returns the set of
 * aligned addresses inside [base, textEnd).
 */
function readTextPointers(buf, parsed, base, textEnd) {
    const out = new Set();
    for (const [sectionName, relaName] of [
        [".rodata", ".rela.rodata"],
        [".data", ".rela.data"],
    ]) {
        const section = rpxlib.findSection(parsed, sectionName);
        const rela = rpxlib.findSection(parsed, relaName);
        if (!section || !rela) continue;
        const { data } = rpxlib.readSectionData(buf, section);
        const { relocations } = rpxlib.readRelocations(buf, parsed, relaName);
        for (const r of relocations) {
            if (r.type !== 1) continue; // R_PPC_ADDR32
            const off = (r.offset - section.addr) >>> 0;
            if (off + 4 > data.length) continue;
            const word = data.readUInt32BE(off);
            if (word >= base && word < textEnd && (word & 3) === 0) out.add(word >>> 0);
        }
    }
    return out;
}

/**
 * @param {Buffer} buf   raw RPX file contents
 * @param {object} parsed result of rpxinfo's parseRpx()
 * @param {object} [opts] { textSection: ".text" }
 */
function analyzeRpx(buf, parsed, opts = {}) {
    const name = opts.textSection || ".text";
    const section = rpxlib.findSection(parsed, name);
    if (!section) throw new Error(`section ${name} not found`);
    const { data } = rpxlib.readSectionData(buf, section);
    const base = section.addr >>> 0;
    const size = section.logicalSize >>> 0;
    const words = Math.floor(size / 4);
    const textEnd = base + size;

    const categories = new Uint8Array(words); // 0 unknown, 1 supported, 2 known-unsupported
    const unsupportedCount = new Map();
    const unknownOpcodeCount = new Map();
    const starts = new Set([base]);
    const blTargets = [];
    const tailTargets = [];
    const importLikeTargets = []; // bl targets outside .text (import stubs)

    let supportedWords = 0;
    let unsupportedWords = 0;
    let previousWasBoundary = true;

    for (let i = 0; i < words; i++) {
        const addr = base + i * 4;
        const word = data.readUInt32BE(i * 4);
        const instr = decode(word);

        if (instr.supported) {
            categories[i] = 1;
            supportedWords++;
        } else {
            categories[i] = instr.unknownOpcode || instr.invalid ? 0 : 2;
            if (categories[i] === 2) unsupportedWords++;
            const bucket = unsupportedCount;
            const key = instr.name.startsWith("op") ? instr.name : `${instr.name}`;
            bucket.set(key, (bucket.get(key) || 0) + 1);
            if (instr.unknownOpcode) unknownOpcodeCount.set(instr.name, (unknownOpcodeCount.get(instr.name) || 0) + 1);
        }

        // Function-start evidence.
        if (instr.branch === "bl") {
            const target = instr.aa ? instr.li >>> 0 : (addr + instr.li) >>> 0;
            if (target >= base && target < textEnd) blTargets.push(target);
            else importLikeTargets.push({ site: addr, target });
        } else if (instr.branch === "b") {
            const target = instr.aa ? instr.li >>> 0 : (addr + instr.li) >>> 0;
            if (target >= base && target < textEnd) tailTargets.push({ site: addr, target });
        }

        if (previousWasBoundary && looksLikePrologue(word)) starts.add(addr);
        previousWasBoundary = isBoundaryWord(word);

        // Ignore jumps landing outside .text for boundary purposes.
    }
    for (const t of blTargets) starts.add(t);

    // Pointer-only entries: table pointers in `.rodata`/`.data` that no
    // branch reaches. Kept apart from the branch-derived census (so both
    // can be compared with the local Ghidra census); the translator merges
    // them when it needs translation ranges.
    const pointerSet = readTextPointers(buf, parsed, base, textEnd);
    const extraPointerStarts = [...pointerSet].filter((p) => !starts.has(p)).sort((a, b) => a - b);

    const sortedStarts = [...starts].sort((a, b) => a - b);
    const ranges = [];
    let fullySupported = 0;
    let withCalls = 0;
    for (let i = 0; i < sortedStarts.length; i++) {
        const start = sortedStarts[i];
        const end = i + 1 < sortedStarts.length ? Math.min(sortedStarts[i + 1], textEnd) : textEnd;
        let ok = true;
        let calls = 0;
        for (let off = start; off < end; off += 4) {
            const idx = (off - base) >> 2;
            if (categories[idx] !== 1) ok = false;
        }
        // Count call sites inside the range with a light second scan only
        // for functions (skip: expensive on 9M words; computed on demand by
        // the translator). We only need the boolean-ish statistic here, so
        // approximate `withCalls` from bl targets falling inside ranges.
        ranges.push({ start, end });
        if (ok) fullySupported++;
        void calls;
    }
    for (const t of blTargets) {
        // A bl target implies its caller is a function; count ranges that
        // contain any bl target.
        void t;
    }

    // Count functions with inbound calls (cheap: mark via starts index).
    const startSet = new Set(sortedStarts);
    for (let i = 0; i < words; i++) {
        const word = data.readUInt32BE(i * 4);
        if ((word >>> 26) !== 18) continue;
        const lk = word & 1;
        if (!lk) continue;
        const li = LI_SIGN(word);
        const addr = base + i * 4;
        const target = (addr + li) >>> 0;
        if (startSet.has(target)) withCalls++;
    }

    const topUnsupported = [...unsupportedCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);

    return {
        section: section.name,
        base,
        size,
        words,
        functionCount: sortedStarts.length,
        functionStarts: sortedStarts,
        pointerStarts: extraPointerStarts,
        ranges,
        coverage: {
            supported: supportedWords,
            unsupported: unsupportedWords,
            unknown: words - supportedWords - unsupportedWords,
            topUnsupported,
        },
        stats: {
            blTargetsInText: blTargets.length,
            blTargetsOutsideText: importLikeTargets.length,
            tailBranchesInText: tailTargets.length,
            fullySupportedFunctions: fullySupported,
            functionsWithInboundCall: withCalls,
            pointerStartsTotal: pointerSet.size,
            pointerStartsExtra: extraPointerStarts.length,
        },
    };
}

module.exports = { analyzeRpx };
