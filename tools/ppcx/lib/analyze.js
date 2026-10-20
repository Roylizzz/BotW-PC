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
 *      that no branch scan can reach);
 *   5. the entries of an inline `b`-table switch (reached only through a
 *      computed `bctr`) are reported as `tableStarts`; promoting them splits
 *      ranges and exposes the case labels, which the cross-range fixpoint
 *      then records as `tailStarts`.
 *
 * Ranges are then [start_i, start_{i+1}), which is exact when the
 * discovery found every start and approximate otherwise (absolute pointer
 * tables are covered by relocation-derived starts and inline branch tables
 * by `tableStarts`; runtime-built targets remain invisible to a static
 * scan — the local Ghidra census is used to measure the overlap).
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
 * Cross-range direct-branch targets. When `translate` sees a `b`/`bc` whose
 * target lies outside the site's own range it emits a runtime dispatch, so
 * the target must be a registered start; otherwise the dispatch fails at
 * run time. Every in-text direct branch therefore needs its target either
 * inside [start(site), end(site)) or in the start set. Adding a target
 * splits a range, which can expose new cross-range pairs, so this iterates
 * to a fixpoint. Returns the sorted addresses to add (never in `union`).
 */
function findCrossRangeTailTargets(branchStarts, pointerSet, directPairs, textEnd, extraStarts = []) {
    let union = [...branchStarts, ...pointerSet, ...extraStarts].sort((a, b) => a - b);
    const added = new Set();
    for (;;) {
        const candidates = new Set();
        for (let i = 0; i < directPairs.length; i += 2) {
            const site = directPairs[i];
            const target = directPairs[i + 1];
            const ti = upperBound(union, target) - 1;
            if (union[ti] === target) continue; // target is already a start
            const si = upperBound(union, site) - 1;
            const start = union[si];
            const end = si + 1 < union.length ? union[si + 1] : textEnd;
            if (target >= start && target < end) continue; // intra-range goto
            candidates.add(target);
        }
        let grew = false;
        for (const c of candidates) {
            if (!added.has(c)) {
                added.add(c);
                grew = true;
            }
        }
        if (!grew) break;
        union = [...union, ...candidates].sort((a, b) => a - b);
    }
    return [...added].sort((a, b) => a - b);
}

/** Index of the first element > value (all values unique and sorted). */
function upperBound(arr, value) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/* -------------------------------------------------------------------------
 * Inline branch tables
 *
 * Metrowerks emits small switches as an inline table of `b` instructions
 * immediately after the dispatch:
 *
 *     addis r0, 0, table@ha      (or lis)
 *     addic r0, r0, table@l      (addic: r0 is a real register here)
 *     slwi  rX, rX, 2
 *     add   r0, rX, r0
 *     mtctr r0
 *     bctr
 *   table:
 *     b case0
 *     b case1
 *     ...
 *
 * The entries are code inside the function body, so no branch target and no
 * relocation points at them; without promotion `PPCX_DISPATCH` rejects the
 * computed target at run time. This pass recognises the exact shape and
 * returns every entry address of the run. The register tracer is deliberately
 * small: it follows the compiler's lis/addi/addic/mr chains backwards inside
 * one basic block and gives up on anything else.
 * ----------------------------------------------------------------------- */

const DEF_LOADS = new Set([
    "lwz", "lwzu", "lwzx", "lwzux", "lhz", "lhzu", "lhzx", "lhzux",
    "lha", "lhau", "lhax", "lhaux", "lbz", "lbzu", "lbzx", "lbzux",
    "lwa", "lwax", "lwarx", "lfs", "lfsx", "lfd", "lfdx",
]);
const DEF_D_FORM = new Set([
    "addi", "addis", "addic", "addic.", "ori", "oris", "xori", "xoris",
    "andi.", "andis.",
]);
const DEF_ARITH = new Set([
    "add", "addc", "adde", "addme", "addze", "subf", "subfc", "subfe",
    "subfme", "subfze", "mullw", "mulhw", "mulhwu", "divw", "divwu", "neg",
]);
const DEF_LOGICAL = new Set(["and", "andc", "or", "orc", "xor", "nand", "nor", "eqv"]);
const DEF_SHIFT = new Set(["rlwinm", "rlwimi", "rlwnm", "srawi", "slw", "srw", "sraw", "extsh", "extsb", "cntlzw"]);

/**
 * Destination register of an instruction, or -1 when it does not write one.
 * The decoder exposes the raw operand fields, so the destination differs by
 * form: `add`/loads/`addi` write `rt`, while `or` and the shift/logical
 * forms write `ra` (rA in the ISA tables).
 */
function destinationOf(ins) {
    if (!ins.supported || ins.branch || ins.name === "mtspr") return -1;
    if (DEF_LOADS.has(ins.name) || DEF_D_FORM.has(ins.name) || DEF_ARITH.has(ins.name)) return ins.rt;
    if (DEF_LOGICAL.has(ins.name) || DEF_SHIFT.has(ins.name)) return ins.ra;
    if (ins.name === "mfspr" || ins.name === "mfcr" || ins.name === "mfmsr" || ins.name === "mftb") return ins.rt;
    return -1;
}

function textIns(data, base, addr) {
    const ins = decode(data.readUInt32BE(addr - base));
    ins.addr = addr;
    return ins;
}

/**
 * Nearest earlier writer of `reg` inside the basic block that ends at
 * `fromAddr`. Any branch ends the search: a preceding `bl` may have
 * clobbered r0-r12, and every other branch ends the block.
 */
function findWriter(data, base, fromAddr, reg, stop) {
    let addr = fromAddr - 4;
    for (let n = 0; n < 48 && addr >= stop; n++, addr -= 4) {
        const ins = textIns(data, base, addr);
        if (ins.branch) return null;
        if (destinationOf(ins) === reg) return ins;
    }
    return null;
}

/** Resolve lis/addi/addic/mr chains to an absolute value, or null. */
function resolveConstant(data, base, fromAddr, reg, stop, depth = 0) {
    if (depth > 4) return null;
    const w = findWriter(data, base, fromAddr, reg, stop);
    if (!w) return null;
    // addi/addis with rA=0 are the li/lis idiom (the literal zero is used,
    // not GPR0). addic is different: rA=0 really means GPR0.
    if (w.name === "addis" && w.ra === 0) return (w.imm << 16) >>> 0;
    if (w.name === "addi" && w.ra === 0) return w.imm >>> 0;
    if (w.name === "addi" || w.name === "addic" || w.name === "addic.") {
        const b = resolveConstant(data, base, w.addr, w.ra, stop, depth + 1);
        return b === null ? null : (b + w.imm) >>> 0;
    }
    if (w.name === "addis") {
        const b = resolveConstant(data, base, w.addr, w.ra, stop, depth + 1);
        return b === null ? null : (b + ((w.imm << 16) >>> 0)) >>> 0;
    }
    // `or rD, rS, rS` is mr rD, rS.
    if (w.name === "or" && w.rt === w.rb) {
        return resolveConstant(data, base, w.addr, w.rt, stop, depth + 1);
    }
    return null;
}

/**
 * Branch-table entries: for every `bctr` whose CTR comes from
 * `add rIdx, rBase` with a statically known in-text table address, return
 * the addresses of the consecutive `b` words at that table. Entries already
 * in `starts` are ignored (they have a body already).
 */
function findBranchTableStarts(data, base, textEnd, starts) {
    const words = Math.floor((textEnd - base) / 4);
    const out = new Set();
    for (let i = 0; i < words; i++) {
        if (data.readUInt32BE(i * 4) !== BCTR) continue;
        const site = base + i * 4;
        const si = upperBound(starts, site) - 1;
        if (si < 0) continue;
        const stop = starts[si];

        let mtctr = null;
        for (let p = site - 4, n = 0; p >= stop && n < 16; p -= 4, n++) {
            const ins = textIns(data, base, p);
            if (ins.branch) break;
            if (ins.name === "mtspr" && ins.spr === 9) {
                mtctr = ins;
                break;
            }
        }
        if (!mtctr) continue;

        const writer = findWriter(data, base, mtctr.addr, mtctr.rt, stop);
        if (!writer || writer.name !== "add") continue;

        let table = null;
        for (const reg of [writer.ra, writer.rb]) {
            const v = resolveConstant(data, base, writer.addr, reg, stop);
            if (v !== null && v >= base && v < textEnd) {
                table = v;
                break;
            }
        }
        if (table === null) continue;
        if (starts[upperBound(starts, table) - 1] === table) continue;
        if (textIns(data, base, table).branch !== "b") continue;

        for (let p = table; p + 4 <= textEnd && p - table < 256 * 4; p += 4) {
            const ins = textIns(data, base, p);
            if (ins.branch !== "b") break;
            const target = ins.aa ? ins.li >>> 0 : (p + ins.li) >>> 0;
            if (target < base || target >= textEnd) break;
            out.add(p);
        }
    }
    return [...out].sort((a, b) => a - b);
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
    let tailBranchesInText = 0;
    const directPairs = []; // flat [site, target, ...] for in-text `b`/`bc` targets
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
            if (target >= base && target < textEnd) {
                tailBranchesInText++;
                directPairs.push(addr, target);
            }
        } else if (instr.branch === "bc") {
            const target = instr.aa ? instr.bd >>> 0 : (addr + instr.bd) >>> 0;
            if (target >= base && target < textEnd) directPairs.push(addr, target);
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

    // Inline branch tables are code entries inside a function body. Promote
    // them before the cross-range fixpoint: each entry splits a range, which
    // in turn exposes the case labels its `b` targets point at.
    const tableEntries = findBranchTableStarts(data, base, textEnd, sortedStarts);
    const tableStarts = tableEntries.filter((p) => !starts.has(p) && !pointerSet.has(p));

    // Cross-range direct-branch targets: a `b` to an address outside the
    // site's own range becomes a runtime dispatch, so the target must be a
    // registered start. Computed over the final partition (branch starts
    // plus pointer starts plus table entries) and iterated to a fixpoint.
    const tailStarts = findCrossRangeTailTargets(sortedStarts, pointerSet, directPairs, textEnd, tableStarts);
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
        tableStarts,
        tailStarts,
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
            tailBranchesInText,
            fullySupportedFunctions: fullySupported,
            functionsWithInboundCall: withCalls,
            pointerStartsTotal: pointerSet.size,
            pointerStartsExtra: extraPointerStarts.length,
            tableStartsAdded: tableStarts.length,
            tailStartsAdded: tailStarts.length,
        },
    };
}

module.exports = { analyzeRpx };
