#!/usr/bin/env node
"use strict";

/**
 * ppcx: PowerPC -> C static recompiler for Wii U RPX modules (first iteration).
 *
 * Subcommands:
 *   analyze    function-boundary discovery + instruction coverage of .text
 *   imports    imported-function inventory (by module, with call sites)
 *   translate  translate a function (and optionally its callees) to C
 *   disasm     disassemble a small address range
 *
 * The C output is generated from the user's own game dump and written under
 * build/ (git-ignored); it is never part of this repository.
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const rpxlib = require("../rpxinfo/lib/rpx.js");
const { analyzeRpx } = require("./lib/analyze.js");
const { collectImports, buildImportMaps } = require("./lib/imports.js");
const { decode } = require("./lib/decode.js");
const { translateFunction, branchTarget, hex8, fnName, addrHex } = require("./lib/translate.js");
const { buildImage, serializeImage, readImageBlob, ImageError } = require("./lib/image.js");

const USAGE = `ppcx - PowerPC -> C recompiler prototype (BotW-PC)

Usage: node ppcx.js <command> [options]

Commands:
  analyze    --rpx <file> [--cache <json>] [--top N]
  imports    --rpx <file> [--module <name>] [--list] [--limit N]
  translate  --rpx <file> --fn <addr> [--follow N] [--max N] --out <dir> [--report <json>]
  image      --rpx <file> [--out <dir>] [--expect-sha256 <hex>]
  disasm     --rpx <file> --addr <addr> [--count N]

Addresses accept decimal or 0x-prefixed hex.
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
    console.error(`ppcx: ${msg}`);
    process.exit(2);
}

function numArg(v, dflt, what) {
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`invalid ${what}: ${v}`);
    return n;
}

function u32hex(n) {
    return `0x${(n >>> 0).toString(16)}u`;
}

/**
 * Loads and parses one RPX into the shape the pipeline works with. `file` is
 * a label (a path for real dumps, a synthetic name for in-memory fixtures).
 */
function loadRpxFrom(buf, file) {
    const parsed = rpxlib.parseRpx(buf);
    const text = rpxlib.findSection(parsed, ".text");
    if (!text) fail(".text section not found");
    const { data } = rpxlib.readSectionData(buf, text);
    const base = text.addr >>> 0;
    const size = (text.logicalSize !== undefined ? text.logicalSize : text.size) >>> 0;
    const symbols = rpxlib.readSymbols(buf, parsed);
    const reloc = rpxlib.readRelocations(buf, parsed, ".rela.text");
    const relocations = reloc ? reloc.relocations : [];
    const collected = collectImports(parsed, symbols, relocations);
    const maps = buildImportMaps(collected.imports);
    return {
        file,
        buf,
        parsed,
        text,
        data,
        base,
        size,
        symbols,
        relocations,
        imports: collected.imports,
        importNotes: collected.notes,
        maps,
    };
}

function loadRpx(file) {
    if (!file) fail("--rpx <file> is required");
    return loadRpxFrom(fs.readFileSync(file), file);
}

const ANALYSIS_VERSION = 9; // bump when decode/analysis semantics change

function computeAnalysis(rpx) {
    const a = analyzeRpx(rpx.buf, rpx.parsed);
    return {
        version: ANALYSIS_VERSION,
        textBase: a.base,
        textSize: a.size,
        words: a.words,
        functionCount: a.functionCount,
        functionStarts: a.functionStarts,
        pointerStarts: a.pointerStarts,
        tableStarts: a.tableStarts,
        tailStarts: a.tailStarts,
        coverage: a.coverage,
        stats: a.stats,
    };
}

function loadOrComputeAnalysis(rpx, cacheFile) {
    if (cacheFile && fs.existsSync(cacheFile)) {
        const j = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (j.version === ANALYSIS_VERSION && j.textBase === rpx.base && j.textSize === rpx.size) return { analysis: j, cached: true };
    }
    const analysis = computeAnalysis(rpx);
    if (cacheFile) {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(analysis));
    }
    return { analysis, cached: false };
}

function pct(part, total) {
    return total === 0 ? "n/a" : `${((100 * part) / total).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

function cmdAnalyze(args) {
    const rpx = loadRpx(args.rpx);
    const cacheFile = args.cache;
    const { analysis, cached } = loadOrComputeAnalysis(rpx, cacheFile);
    const top = args.top !== undefined ? Number(args.top) : 20;

    console.log(`file:      ${rpx.file}`);
    console.log(`.text:     base 0x${hex8(rpx.base)}  size ${rpx.size} bytes (${analysis.words} words)`);
    console.log(`functions: ${analysis.functionCount} starts${cached ? " (cached)" : ""}`);
    const ptrTotal = analysis.stats.pointerStartsTotal ?? 0;
    const ptrExtra = analysis.stats.pointerStartsExtra ?? 0;
    console.log(`pointers:  ${ptrTotal} .rodata/.data code pointers, ${ptrExtra} extra function starts`);
    console.log(`tables:    ${analysis.stats.tableStartsAdded ?? 0} inline branch-table entries added as starts`);
    console.log(`tails:     ${analysis.stats.tailStartsAdded ?? 0} cross-range branch targets added as starts`);
    const cov = analysis.coverage;
    const total = cov.supported + cov.unsupported + cov.unknown;
    console.log(`coverage:  supported ${cov.supported} (${pct(cov.supported, total)}), ` +
        `known-unsupported ${cov.unsupported} (${pct(cov.unsupported, total)}), ` +
        `unknown/data ${cov.unknown} (${pct(cov.unknown, total)})`);
    console.log(`stats:     ${JSON.stringify(analysis.stats)}`);
    console.log(`top unsupported instructions:`);
    for (const [name, count] of cov.topUnsupported.slice(0, top)) {
        console.log(`  ${count.toString().padStart(8)}  ${name}`);
    }
    if (cacheFile) console.log(`cache:     ${cacheFile}${cached ? " (loaded)" : " (written)"}`);
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

function cmdImports(args) {
    const rpx = loadRpx(args.rpx);
    const notes = rpx.importNotes;
    console.log(`imports:   ${notes.total} slots ` +
        `(${notes.functions} functions, ${notes.data} data), ` +
        `${notes.callSites} REL24 call sites, ${notes.addrSites} ADDR16 sites`);
    const byModule = new Map();
    for (const im of rpx.imports) {
        const r = byModule.get(im.module) || { imports: 0, fns: 0, data: 0, callSites: 0, addrSites: 0 };
        r.imports++;
        if (im.kind === "function") r.fns++;
        else r.data++;
        r.callSites += im.callSites.length;
        r.addrSites += im.addrSites.length;
        byModule.set(im.module, r);
    }
    const rows = [...byModule.entries()].sort((a, b) => b[1].imports - a[1].imports);
    console.log("by module:");
    for (const [mod, r] of rows) {
        console.log(`  ${mod.padEnd(16)} imports ${String(r.imports).padStart(4)}  ` +
            `call sites ${String(r.callSites).padStart(6)}  addr sites ${String(r.addrSites).padStart(3)}`);
    }
    if (args.module) {
        const list = rpx.imports.filter((i) => i.module === args.module);
        if (list.length === 0) fail(`no imports for module ${args.module}`);
        console.log(`imports of ${args.module} (${list.length}):`);
        for (const im of list) {
            console.log(`  [${String(im.index).padStart(4)}] ${im.kind === "function" ? "fn " : "dat"} ` +
                `${im.name.padEnd(40)} slot 0x${hex8(im.slot)}  calls ${im.callSites.length}  addr ${im.addrSites.length}`);
        }
    } else if (args.list) {
        const limit = args.limit !== undefined ? Number(args.limit) : 200;
        const active = rpx.imports.filter((i) => i.callSites.length + i.addrSites.length > 0);
        console.log(`imports with relocations (${active.length}, showing ${Math.min(limit, active.length)}):`);
        for (const im of active.slice(0, limit)) {
            console.log(`  [${String(im.index).padStart(4)}] ${im.kind === "function" ? "fn " : "dat"} ` +
                `${im.module}.${im.name}  calls ${im.callSites.length}  addr ${im.addrSites.length}`);
        }
    }
}

// ---------------------------------------------------------------------------
// translate
// ---------------------------------------------------------------------------

function buildRangeMap(starts, textEnd) {
    const ranges = new Map();
    for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : textEnd;
        ranges.set(starts[i], end);
    }
    return ranges;
}

/**
 * Cheap callee scan used to grow the translation set before emitting.
 * Only decodes; no code is generated.
 */
function scanCallees(rpx, start, end, startSet) {
    const found = new Set();
    for (let addr = start; addr < end; addr += 4) {
        const w = rpx.data.readUInt32BE(addr - rpx.base);
        const op = w >>> 26;
        if (op !== 18 && op !== 16) continue;
        const ins = decode(w);
        ins.addr = addr;
        const target = branchTarget(ins);
        if (target < start || target >= end) {
            if (target >= rpx.base && target < rpx.base + rpx.size && startSet.has(target)) {
                if (!rpx.maps.callSite.has(addr)) found.add(target);
            }
        }
    }
    return [...found];
}

/**
 * Translates a module (a real RPX dump or a synthetic fixture) into one C
 * translation unit. `roots` is the set of entry functions to translate; each
 * root grows its callees up to `follow` levels. `entry` (defaults to
 * roots[0]) is the address published as ppcx_entry.
 *
 * Returns `{ gen, report, ordered, truncated }`: the text of gen.c, the same
 * report the CLI writes as translate-report.json, the ordered translated
 * starts and whether the `max` function cap was hit.
 */
function translateModule({ rpx, analysis, roots, entry, follow = 0, max = 256 }) {
    const startSet = new Set([
        ...analysis.functionStarts,
        ...(analysis.pointerStarts || []),
        ...(analysis.tableStarts || []),
        ...(analysis.tailStarts || []),
    ]);
    const ranges = buildRangeMap([...startSet].sort((a, b) => a - b), rpx.base + rpx.size);

    if (!Array.isArray(roots) || roots.length === 0) throw new Error("translateModule needs at least one root");
    for (const candidate of roots) {
        if (!startSet.has(candidate)) {
            const near = analysis.functionStarts.filter((a) => a <= candidate).pop();
            throw new Error(
                `0x${hex8(candidate)} is not a known function start` +
                    (near ? ` (closest start at or below: 0x${hex8(near)})` : "")
            );
        }
    }
    const root = entry !== undefined ? entry : roots[0];
    if (!startSet.has(root)) throw new Error(`entry 0x${hex8(root)} is not a known function start`);

    // Grow the translation set (BFS over callees from every root).
    const discovered = new Map(roots.map((r) => [r, 0]));
    const queue = [...roots];
    let truncated = false;
    while (queue.length > 0) {
        const addr = queue.shift();
        const depth = discovered.get(addr);
        if (depth >= follow) continue;
        const end = ranges.get(addr);
        if (end === undefined) continue;
        for (const callee of scanCallees(rpx, addr, end, startSet)) {
            if (discovered.has(callee)) continue;
            if (discovered.size >= max) {
                truncated = true;
                break;
            }
            discovered.set(callee, depth + 1);
            queue.push(callee);
        }
    }

    const emitSet = new Set(discovered.keys());
    const ordered = [...discovered.keys()].sort((a, b) => a - b);
    const results = [];
    for (const addr of ordered) {
        const end = ranges.get(addr);
        const r = translateFunction({
            data: rpx.data,
            base: rpx.base,
            start: addr,
            end,
            textBase: rpx.base,
            textEnd: rpx.base + rpx.size,
            startSet,
            emitSet,
            callSite: rpx.maps.callSite,
            dataSite: rpx.maps.dataSite,
        });
        results.push(r);
    }

    // Tally what the translation unit needs from the runtime.
    const hleCounts = new Map();
    const addrTakenCounts = new Map();
    const externalTargets = new Set();
    let instructionCount = 0;
    let unsupportedCount = 0;
    let warningCount = 0;
    for (const r of results) {
        instructionCount += r.stats.instructions;
        unsupportedCount += r.unsupported.reduce((n, u) => n + u.count, 0);
        warningCount += r.warnings.length;
        for (const idx of r.hleCalls) hleCounts.set(idx, (hleCounts.get(idx) || 0) + 1);
        for (const idx of r.importAddrs) addrTakenCounts.set(idx, (addrTakenCounts.get(idx) || 0) + 1);
        for (const t of r.externalTargets) externalTargets.add(t);
    }

    /* Every import the unit mentions — called through a REL24 site or only
     * address-taken through an ADDR16 site — must resolve through
     * ppcx_import_name: a dispatcher trampoline for an address-taken import
     * whose name is missing would report "unknown-import" and silently
     * no-op (found by the tests/boot fixture). */
    const usedImports = new Set([...hleCounts.keys(), ...addrTakenCounts.keys()]);

    // Emit the generated translation unit.
    const gen = [];
    gen.push("/*");
    gen.push(" * Generated by tools/ppcx from the user's own game dump.");
    gen.push(" * This file is a derived work of a copyrighted game and must never be");
    gen.push(" * committed to the repository (see .gitignore: build/).");
    gen.push(" */");
    gen.push('#include "ppcx_abi.h"');
    gen.push("");
    gen.push("/* Forward declarations: calls go across address order. */");
    for (const r of results) gen.push(`static void ${r.name}(Cpu *c);`);
    gen.push("");
    for (const r of results) {
        gen.push(r.code);
        gen.push("");
    }
    gen.push("const PpcxEntry ppcx_functions[] = {");
    for (const r of results) gen.push(`    { ${addrHex(r.start)}, ${r.name} },`);
    gen.push("};");
    gen.push("const unsigned ppcx_function_count = sizeof(ppcx_functions) / sizeof(ppcx_functions[0]);");
    gen.push(`const u32 ppcx_entry = ${addrHex(root)};`);
    gen.push("");
    gen.push("/* Names of the imports this unit mentions (called or address-taken), for the HLE layer. */");
    gen.push("const char *ppcx_import_name(u32 import_index) {");
    gen.push("    switch (import_index) {");
    for (const idx of [...usedImports].sort((a, b) => a - b)) {
        const im = rpx.imports[idx];
        const label = `${im.module}.${im.name}`;
        gen.push(`    case ${idx}u: return ${JSON.stringify(label)};`);
    }
    gen.push('    default: return "unknown-import";');
    gen.push("    }");
    gen.push("}");
    gen.push("");
    const report = {
        rpx: rpx.file,
        root,
        follow,
        max,
        truncated,
        functions: results.map((r) => ({
            name: r.name,
            start: r.start,
            end: r.end,
            instructions: r.stats.instructions,
            labels: r.stats.labels,
            callees: r.callees,
            unsupported: r.unsupported,
            warnings: r.warnings,
            hle: r.hleCalls,
            importAddrs: r.importAddrs,
            externalTargets: r.externalTargets,
        })),
        hleImportsUsed: [...usedImports].sort((a, b) => a - b).map((idx) => {
            const im = rpx.imports[idx];
            return {
                index: idx,
                module: im.module,
                name: im.name,
                kind: im.kind,
                calls: hleCounts.get(idx) || 0,
                addressTaken: addrTakenCounts.get(idx) || 0,
            };
        }),
        externalTargets: [...externalTargets].sort((a, b) => a - b),
        totals: {
            functions: results.length,
            instructions: instructionCount,
            unsupportedInstructions: unsupportedCount,
            warnings: warningCount,
        },
    };
    return { gen: gen.join("\n"), report, ordered, truncated };
}

function cmdTranslate(args) {
    const rpx = loadRpx(args.rpx);
    const outDir = args.out || "build/ppcx";
    fs.mkdirSync(outDir, { recursive: true });
    const cacheFile = args.cache || path.join(outDir, "analysis.json");
    const { analysis, cached } = loadOrComputeAnalysis(rpx, cacheFile);
    if (!cached) console.log(`analysis: computed and cached to ${cacheFile}`);

    const startSet = new Set([
        ...analysis.functionStarts,
        ...(analysis.pointerStarts || []),
        ...(analysis.tableStarts || []),
        ...(analysis.tailStarts || []),
    ]);
    const root = numArg(args.fn, undefined, "--fn address");
    if (root === undefined) fail("--fn <addr> is required");
    if (!startSet.has(root)) {
        const near = analysis.functionStarts.filter((a) => a <= root).pop();
        fail(`0x${hex8(root)} is not a known function start` + (near ? ` (closest start at or below: 0x${hex8(near)})` : ""));
    }

    const follow = numArg(args.follow, 0, "--follow");
    const max = Math.max(1, numArg(args.max, 256, "--max"));

    const { gen, report } = translateModule({ rpx, analysis, roots: [root], entry: root, follow, max });
    const genPath = path.join(outDir, "gen.c");
    fs.writeFileSync(genPath, gen);
    const reportPath = args.report || path.join(outDir, "translate-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(`translated ${report.totals.functions} function(s), ${report.totals.instructions} instructions` +
        (report.truncated ? ` (capped at --max ${max})` : ""));
    console.log(`HLE imports used: ${report.hleImportsUsed.length}` +
        (report.hleImportsUsed.length > 0
            ? ` (${report.hleImportsUsed.map((h) => `${h.module}.${h.name}`).slice(0, 8).join(", ")}${report.hleImportsUsed.length > 8 ? ", ..." : ""})`
            : ""));
    console.log(`external targets left to the runtime dispatcher: ${report.externalTargets.length}`);
    console.log(`unsupported instructions: ${report.totals.unsupportedInstructions}, warnings: ${report.totals.warnings}`);
    console.log(`wrote ${genPath}`);
    console.log(`wrote ${reportPath}`);
}

// ---------------------------------------------------------------------------
// image
// ---------------------------------------------------------------------------

function cmdImage(args) {
    const file = args.rpx;
    if (!file) fail("--rpx <file> is required");
    const buf = fs.readFileSync(file);
    const parsed = rpxlib.parseRpx(buf);
    const outDir = args.out || "build/ppcx";

    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    if (args["expect-sha256"] !== undefined) {
        const expected = String(args["expect-sha256"]).toLowerCase();
        if (expected !== sha256) fail(`RPX sha256 mismatch: expected ${expected}, file is ${sha256}`);
    }

    let plan;
    let blob;
    try {
        plan = buildImage(buf, parsed);
        blob = serializeImage(plan);
    } catch (e) {
        if (!(e instanceof ImageError)) throw e;
        console.error(`ppcx: the load image has ${e.issues.length} problem(s):`);
        for (const issue of e.issues.slice(0, 20)) console.error(`  ${issue}`);
        if (e.issues.length > 20) console.error(`  ... and ${e.issues.length - 20} more`);
        process.exit(2);
    }

    const blobSha = crypto.createHash("sha256").update(blob).digest("hex");
    fs.mkdirSync(outDir, { recursive: true });
    const binPath = path.join(outDir, "image.bin");
    fs.writeFileSync(binPath, blob);

    const manifest = {
        rpx: file,
        rpxSha256: sha256,
        blobSha256: blobSha,
        blobBytes: blob.length,
        checksum: readImageBlob(blob).checksum,
        stats: plan.stats,
        relocations: plan.relocations,
        tls: plan.tls,
        segments: plan.segments.map((s) => ({
            name: s.name,
            addr: s.addr,
            size: s.size,
            bss: (s.flags & 1) !== 0,
        })),
        notes: plan.notes,
    };
    const jsonPath = path.join(outDir, "image.json");
    fs.writeFileSync(jsonPath, JSON.stringify(manifest, null, 2));

    console.log(`file:      ${file}`);
    console.log(`sha256:    ${sha256}`);
    console.log(`segments:  ${plan.stats.sections} mapped, ${plan.stats.bytes} bytes ` +
        `(${plan.stats.payloadBytes} data + ${plan.stats.bssBytes} BSS)`);
    for (const r of plan.relocations.applied) {
        console.log(`relocs:    ${r.count} applied (${r.name})`);
    }
    console.log(`relocs:    ${plan.relocations.code} in executable sections (recompiler), ` +
        `${plan.relocations.none} none`);
    if (plan.tls.sites.length > 0) {
        console.log(`tls:       main module ${plan.tls.module}, block ${plan.tls.blockBytes} bytes`);
        for (const s of plan.tls.sites.slice(0, 10)) {
            console.log(`  tls: ${s.type} at 0x${hex8(s.addr)} (${s.section}, ` +
                `${s.symbol || "no symbol"} -> 0x${hex8(s.value)})`);
        }
    }
    for (const n of plan.notes) console.log(`note:      ${n}`);
    console.log(`wrote      ${binPath} (${blob.length} bytes, sha256 ${blobSha.slice(0, 16)}...)`);
    console.log(`wrote      ${jsonPath}`);
}

// ---------------------------------------------------------------------------
// disasm
// ---------------------------------------------------------------------------

function formatIns(ins) {
    const f = (v) => (typeof v === "number" && v < 0 ? `${v}` : `${v}`);
    switch (ins.name) {
        case "b":
        case "bl":
            return `${ins.name} 0x${hex8(branchTarget(ins))}${ins.lk ? " (link)" : ""}`;
        case "bc":
            return `bc bo=${ins.bo} bi=${ins.bi} -> 0x${hex8(branchTarget(ins))}`;
        case "bclr":
        case "bcctr":
            return `${ins.name} bo=${ins.bo} bi=${ins.bi}${ins.lk ? " (link)" : ""}`;
        default:
            break;
    }
    const parts = [];
    const push = (k, v) => {
        if (v !== undefined) parts.push(`${k}${f(v)}`);
    };
    if (ins.frd !== undefined) push("fr", ins.frd);
    if (ins.rt !== undefined && ins.frd === undefined) push("r", ins.rt);
    if (ins.rs !== undefined && ins.rs !== ins.rt) push("rs", ins.rs);
    if (ins.ra !== undefined) push("r", ins.ra);
    if (ins.rb !== undefined) push("r", ins.rb);
    if (ins.fra !== undefined && ins.frd !== undefined) push("fr", ins.fra);
    if (ins.frb !== undefined && ins.frd !== undefined) push("fr", ins.frb);
    if (ins.crf !== undefined) push("crf", ins.crf);
    if (ins.spr !== undefined) push("spr", ins.spr);
    if (ins.fm !== undefined) push("fm", `0x${ins.fm.toString(16)}`);
    if (ins.sh !== undefined) push("sh", ins.sh);
    if (ins.mb !== undefined) push("mb", ins.mb);
    if (ins.me !== undefined) push("me", ins.me);
    if (ins.imm !== undefined) push("imm", ins.imm);
    if (ins.uimm !== undefined) push("uimm", `0x${ins.uimm.toString(16)}`);
    return `${ins.name} ${parts.join(", ")}`;
}

function cmdDisasm(args) {
    const rpx = loadRpx(args.rpx);
    const start = numArg(args.addr !== undefined ? args.addr : args.fn, undefined, "--addr");
    if (start === undefined) fail("--addr <addr> is required");
    const count = numArg(args.count, 16, "--count");
    for (let i = 0; i < count; i++) {
        const addr = start + i * 4;
        if (addr + 4 > rpx.base + rpx.size) break;
        const w = rpx.data.readUInt32BE(addr - rpx.base);
        const ins = decode(w);
        ins.addr = addr;
        console.log(`0x${hex8(addr)}  ${hex8(w)}  ${formatIns(ins)}${ins.supported ? "" : "   [unsupported]"}`);
    }
}

// ---------------------------------------------------------------------------

function main() {
    const argv = process.argv.slice(2);
    const command = argv[0];
    const args = parseArgs(argv.slice(1));
    switch (command) {
        case "analyze":
            return cmdAnalyze(args);
        case "imports":
            return cmdImports(args);
        case "translate":
            return cmdTranslate(args);
        case "image":
            return cmdImage(args);
        case "disasm":
            return cmdDisasm(args);
        default:
            console.log(USAGE);
            if (command !== undefined && command !== "--help" && command !== "help") process.exit(2);
    }
}

if (require.main === module) main();

module.exports = {
    loadRpx,
    loadRpxFrom,
    computeAnalysis,
    loadOrComputeAnalysis,
    buildRangeMap,
    scanCallees,
    translateModule,
};
