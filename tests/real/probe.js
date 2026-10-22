"use strict";

/**
 * Local-only real-RPX startup probe.
 *
 * This is a research harness, not a CI test and not a boot claim. It drives
 * the production pipeline (analysis -> translateModule -> image -> compiled
 * runtime) against a user's own RPX and records the first measured blocker.
 *
 * The static recompiler cannot see indirect/virtual call targets. When the
 * runtime reports "branch or call to an address with no registered function",
 * this probe checks whether the analyzer already knows that address as a
 * function/pointer/table/tail start, adds it as an explicit root, retranslates
 * and runs again. Every iteration is bounded by PPCX_MAX_FUNCTIONS so an
 * incomplete service model cannot run away.
 *
 * Generated sources, images, executables and transcripts stay under the
 * git-ignored build/ directory. Nothing derived from the game is committed.
 *
 * Usage:
 *   node tests/real/probe.js --rpx <U-King.rpx> --entry 0x02C5E5F4 \
 *       [--follow 2] [--max 512] [--budget 300] [--iterations 6] \
 *       [--root 0x...]... [--root-table 0x...] [--root-table-limit N] \
 *       [--expand-window bytes] [--image build/ppcx/image.bin] \
 *       [--out build/real-probe]
 *
 * `--root-table` reads a zero-terminated table of u32 function addresses
 * (for example the v208 static-constructor table at 0x1045CC2C) and seeds
 * every entry as a translation root. `--expand-window` adds every known
 * analyzer start in the aligned window around an unknown indirect target,
 * which is much faster than discovering the same constructor cluster one
 * target at a time.
 *
 * Exit status is 0 when the probe produced a measured outcome, including a
 * blocker. Tool failures (invalid RPX, compiler error, translation error) exit
 * non-zero. Without --rpx the probe skips with status 0 so it is safe to run
 * accidentally in a synthetic-only CI shell.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const {
    buildImage,
    serializeImage,
    readImageBlob,
    IMAGE_FLAG_BSS,
} = require("../../tools/ppcx/lib/image.js");
const ppcx = require("../../tools/ppcx/ppcx.js");
const { findCompiler } = require("../isa/run.js");

const ROOT = path.resolve(__dirname, "..", "..");
const RUNTIME_INCLUDE = path.join(ROOT, "src", "runtime", "include");
const RUNTIME_SOURCES = [
    path.join(ROOT, "src", "runtime", "src", "ppcx_runtime.c"),
    path.join(ROOT, "src", "runtime", "src", "ppcx_mem.c"),
    path.join(ROOT, "src", "runtime", "src", "ppcx_hle.c"),
    path.join(ROOT, "src", "runtime", "src", "ppcx_image.c"),
];

const DRIVER = `#include "ppcx_runtime.h"

int main(void) {
    return ppcx_run();
}
`;

function hex8(v) {
    return (v >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function parseAddr(text, what) {
    const s = String(text).trim();
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(s)) {
        throw new Error(`invalid ${what}: ${text}`);
    }
    return Number(s) >>> 0;
}

function numArg(text, dflt, what) {
    if (text === undefined) return dflt;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid ${what}: ${text}`);
    return Math.floor(n);
}

function parseArgs(argv) {
    const out = { roots: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--root") {
            const value = argv[++i];
            if (value === undefined) throw new Error("--root needs an address");
            out.roots.push(parseAddr(value, "--root"));
            continue;
        }
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
            throw new Error(`unexpected argument: ${a}`);
        }
    }
    return out;
}

function lines(text) {
    return text.length === 0 ? [] : text.split(/\r?\n/).filter((l) => l.length > 0);
}

function readImageWord(buf, blob, guestAddr) {
    for (const seg of blob.segments) {
        if (guestAddr < seg.addr || guestAddr + 4 > seg.addr + seg.size) continue;
        if (seg.flags & IMAGE_FLAG_BSS) return 0;
        return buf.readUInt32BE(seg.payloadOffset + (guestAddr - seg.addr));
    }
    throw new Error(`root table address 0x${hex8(guestAddr)} is not in the image`);
}

function readRootTable(imagePath, guestAddr, limit) {
    const buf = fs.readFileSync(imagePath);
    const blob = readImageBlob(buf);
    const roots = [];
    for (let i = 0; i < limit; i++) {
        const value = readImageWord(buf, blob, guestAddr + i * 4);
        if (value === 0) return { roots, terminated: true };
        roots.push(value >>> 0);
    }
    return { roots, terminated: false };
}

function firstMatch(list, re) {
    for (const line of list) {
        const m = re.exec(line);
        if (m) return m;
    }
    return null;
}

function compileProbe(compiler, iterDir, genPath) {
    const driverPath = path.join(iterDir, "driver.c");
    const exePath = path.join(iterDir, "probe.exe");
    fs.writeFileSync(driverPath, DRIVER);
    const isTcc = /(^|[\\/])tcc(\.exe)?$/i.test(compiler);
    const args = [];
    if (isTcc) {
        /* TCC on Windows has no fma/fmaf; the ABI header provides a portable
         * one-rounding fallback under this macro. */
        args.push("-DPPCX_NO_FMA");
    } else {
        args.push("-std=c11", "-O0", "-Wall");
    }
    args.push("-I", RUNTIME_INCLUDE, ...RUNTIME_SOURCES, genPath, driverPath, "-o", exePath);
    if (!isTcc) args.push("-lm");
    const r = spawnSync(compiler, args, { encoding: "utf8" });
    if (r.error || r.status !== 0) {
        const detail = [r.stdout, r.stderr].filter((s) => s && s.length).join("\n");
        throw new Error(`compile failed${r.error ? `: ${r.error.message}` : ""}\n${detail}`);
    }
    return exePath;
}

function buildOrReuseImage(rpx, rpxPath, outDir, requested) {
    if (requested) {
        if (!fs.existsSync(requested)) throw new Error(`image not found: ${requested}`);
        return requested;
    }
    const imagePath = path.join(outDir, "image.bin");
    const manifestPath = path.join(outDir, "image.json");
    const sha256 = crypto.createHash("sha256").update(rpx.buf).digest("hex");
    if (fs.existsSync(imagePath) && fs.existsSync(manifestPath)) {
        try {
            const old = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            if (old.rpxSha256 === sha256) return imagePath;
        } catch {
            /* fall through and rebuild */
        }
    }
    const plan = buildImage(rpx.buf, rpx.parsed);
    const blob = serializeImage(plan);
    fs.writeFileSync(imagePath, blob);
    fs.writeFileSync(
        manifestPath,
        JSON.stringify(
            {
                rpx: rpxPath,
                rpxSha256: sha256,
                blobBytes: blob.length,
                stats: plan.stats,
                relocations: plan.relocations,
                tls: plan.tls,
            },
            null,
            2
        )
    );
    console.log(
        `probe: image ${plan.stats.sections} segment(s), ${plan.stats.bytes} bytes ` +
            `(${plan.stats.bssBytes} BSS) -> ${imagePath}`
    );
    return imagePath;
}

function runProbe(opts) {
    const rpxPath = opts.rpx || process.env.PPCX_RPX;
    if (!rpxPath) {
        console.log("probe: skipped (pass --rpx <U-King.rpx> or set PPCX_RPX)");
        return 0;
    }
    if (!fs.existsSync(rpxPath)) throw new Error(`RPX not found: ${rpxPath}`);

    const compiler = findCompiler();
    if (!compiler) {
        console.log("probe: skipped (no C compiler found; set PPCX_CC)");
        return 0;
    }

    const outDir = path.resolve(opts.out || path.join(ROOT, "build", "real-probe"));
    fs.mkdirSync(outDir, { recursive: true });

    const rpx = ppcx.loadRpx(rpxPath);
    const analysisPath = path.join(outDir, "analysis.json");
    const { analysis, cached } = ppcx.loadOrComputeAnalysis(rpx, analysisPath);
    if (!cached) console.log(`probe: analysis cached at ${analysisPath}`);

    const startSet = new Set([
        ...analysis.functionStarts,
        ...(analysis.pointerStarts || []),
        ...(analysis.tableStarts || []),
        ...(analysis.tailStarts || []),
    ]);
    const entry = parseAddr(opts.entry, "--entry");
    if (!startSet.has(entry)) throw new Error(`entry 0x${hex8(entry)} is not a known start`);

    const imagePath = buildOrReuseImage(
        rpx,
        rpxPath,
        outDir,
        opts.image ? path.resolve(opts.image) : null
    );

    const initialRoots = [entry, ...(opts.roots || [])];
    let rootTable = null;
    if (opts["root-table"] !== undefined) {
        const tableAddr = parseAddr(opts["root-table"], "--root-table");
        const tableLimit = Math.max(1, numArg(opts["root-table-limit"], 8192, "--root-table-limit"));
        const table = readRootTable(imagePath, tableAddr, tableLimit);
        rootTable = {
            addr: `0x${hex8(tableAddr)}`,
            entries: table.roots.length,
            terminated: table.terminated,
        };
        console.log(
            `probe: root table 0x${hex8(tableAddr)}: ${table.roots.length} entr` +
                `${table.roots.length === 1 ? "y" : "ies"}${table.terminated ? "" : " (limit reached)"}`
        );
        initialRoots.push(...table.roots);
    }
    for (const root of initialRoots) {
        if (!startSet.has(root)) throw new Error(`root 0x${hex8(root)} is not a known start`);
    }

    const follow = numArg(opts.follow, 2, "--follow");
    const max = Math.max(1, numArg(opts.max, 512, "--max"));
    const budget = Math.max(1, numArg(opts.budget, 300, "--budget"));
    const iterations = Math.max(1, numArg(opts.iterations, 6, "--iterations"));
    const expandWindow = Math.max(0, numArg(opts["expand-window"], 0, "--expand-window"));

    let roots = [...new Set(initialRoots)];
    const expansions = [];
    const summary = {
        rpx: rpxPath,
        entry,
        follow,
        max,
        budget,
        rootTable,
        expandWindow,
        iterations: 0,
        roots: [],
        expansions,
        outcome: "not-run",
        exitStatus: null,
        reason: null,
        translatedFunctions: 0,
        translatedInstructions: 0,
        firstHle: null,
        firstUnmodeledHle: null,
        lastHle: null,
        fault: null,
        unknownTarget: null,
    };

    console.log(
        `probe: entry 0x${hex8(entry)}, follow ${follow}, budget ${budget}, ` +
            `max ${max}, compiler ${compiler}`
    );

    for (let iteration = 1; iteration <= iterations; iteration++) {
        const iterDir = path.join(outDir, `iter-${iteration}`);
        fs.mkdirSync(iterDir, { recursive: true });
        const genPath = path.join(iterDir, "gen.c");
        const reportPath = path.join(iterDir, "translate-report.json");

        const translated = ppcx.translateModule({
            rpx,
            analysis,
            roots,
            entry,
            follow,
            max,
            traceEntries: true,
        });
        fs.writeFileSync(genPath, translated.gen);
        fs.writeFileSync(reportPath, JSON.stringify(translated.report, null, 2));

        const exePath = compileProbe(compiler, iterDir, genPath);
        const env = { ...process.env };
        delete env.PPCX_HLE_STRICT;
        delete env.PPCX_MAX_FUNCTIONS;
        delete env.PPCX_FN_TRACE;
        delete env.PPCX_DISPATCH_TRACE;
        delete env.PPCX_HLE_TRACE;
        delete env.PPCX_CRASH_TRACE;
        env.PPCX_IMAGE = imagePath;
        env.PPCX_FN_TRACE = "1";
        env.PPCX_DISPATCH_TRACE = "1";
        env.PPCX_HLE_TRACE = "1";
        env.PPCX_MAX_FUNCTIONS = String(budget);
        env.PPCX_CRASH_TRACE = "1";

        const run = spawnSync(exePath, [], {
            encoding: "utf8",
            env,
            timeout: 60000,
        });
        const stderr = run.stderr || "";
        const stdout = run.stdout || "";
        fs.writeFileSync(path.join(iterDir, "transcript.txt"), stdout + stderr);
        const errLines = lines(stderr);

        const fnCount = (translated.report.totals && translated.report.totals.functions) || 0;
        const insCount = (translated.report.totals && translated.report.totals.instructions) || 0;
        summary.iterations = iteration;
        summary.roots = roots.slice();
        summary.translatedFunctions = fnCount;
        summary.translatedInstructions = insCount;

        const hleLines = errLines.filter((l) => l.startsWith("ppcx: HLE "));
        const unmodeled = hleLines.find((l) => l.includes("unimplemented"));
        const firstHle = hleLines.find((l) => l.includes("modeled"));
        const budgetLine = errLines.find((l) => l.includes("function budget reached"));
        const returned = errLines.find((l) => l.includes("entry returned"));
        const fault = errLines.find((l) => l.includes("guest memory fault"));
        const noTranslation = errLines.find((l) => l.includes("no translation yet"));
        const dataImport = errLines.find((l) => l.includes("unmodeled data import"));
        const unknown = firstMatch(errLines, /no registered function \(0x([0-9A-Fa-f]+)\)/);

        if (firstHle && !summary.firstHle) summary.firstHle = firstHle;
        if (unmodeled && !summary.firstUnmodeledHle) summary.firstUnmodeledHle = unmodeled;
        if (hleLines.length > 0) summary.lastHle = hleLines[hleLines.length - 1];

        console.log(
            `probe: iter ${iteration}: ${fnCount} function(s), ${insCount} instructions, ` +
                `exit ${run.status}${translated.truncated ? " (max cap)" : ""}`
        );
        if (firstHle) console.log(`probe:   first HLE: ${firstHle.replace(/^ppcx: /, "")}`);
        if (unmodeled) console.log(`probe:   first unmodeled: ${unmodeled.replace(/^ppcx: /, "")}`);
        if (run.error) console.log(`probe:   runner: ${run.error.message}`);

        if (run.error) {
            summary.outcome = "runner-error";
            summary.exitStatus = run.status;
            summary.reason = run.error.message;
            break;
        }
        if (unknown) {
            const target = parseInt(unknown[1], 16) >>> 0;
            summary.unknownTarget = `0x${hex8(target)}`;
            console.log(`probe:   unregistered dispatch 0x${hex8(target)}`);
            const additions = [];
            if (startSet.has(target) && !roots.includes(target)) additions.push(target);
            if (expandWindow > 0) {
                const windowStart = Math.floor(target / expandWindow) * expandWindow;
                for (const start of startSet) {
                    if (start < windowStart || start >= windowStart + expandWindow) continue;
                    if (!roots.includes(start) && !additions.includes(start)) additions.push(start);
                }
            }
            if (additions.length > 0) {
                roots.push(...additions);
                expansions.push({
                    iteration,
                    target: `0x${hex8(target)}`,
                    added: additions.length,
                    window: expandWindow > 0 ? `0x${hex8(expandWindow)}` : null,
                });
                console.log(
                    `probe:   analyzer knows it; adding ${additions.length} root(s)` +
                        (expandWindow > 0 ? ` around 0x${hex8(target)}` : "") +
                        ` and retrying`
                );
                continue;
            }
            summary.outcome = "unknown-dispatch";
            summary.exitStatus = run.status;
            summary.reason = `no registered function 0x${hex8(target)}; the analyzer does not know it as a start`;
            break;
        }
        if (dataImport) {
            summary.outcome = "unmodeled-data-import";
            summary.exitStatus = run.status;
            summary.reason = dataImport.replace(/^ppcx: /, "");
            break;
        }
        if (fault) {
            summary.outcome = "memory-fault";
            summary.exitStatus = run.status;
            summary.fault = fault.replace(/^ppcx: /, "");
            summary.reason = summary.fault;
            break;
        }
        if (noTranslation) {
            summary.outcome = "translation-gap";
            summary.exitStatus = run.status;
            summary.reason = noTranslation.replace(/^ppcx: /, "");
            break;
        }
        if (budgetLine || run.status === 10) {
            summary.outcome = "budget";
            summary.exitStatus = run.status;
            summary.reason = budgetLine
                ? budgetLine.replace(/^ppcx: /, "")
                : "exit 10 without a parsed budget line";
            break;
        }
        if (returned || run.status === 0) {
            summary.outcome = "returned";
            summary.exitStatus = run.status;
            summary.reason = returned ? returned.replace(/^ppcx: /, "") : "exit 0";
            break;
        }
        summary.outcome = "unexpected-exit";
        summary.exitStatus = run.status;
        summary.reason = errLines.length > 0 ? errLines[errLines.length - 1] : `exit ${run.status}`;
        break;
    }

    if (summary.outcome === "not-run") {
        summary.outcome = "root-limit";
        summary.reason =
            `iteration limit ${iterations} reached while expanding indirect roots` +
            (expansions.length > 0
                ? `; last added 0x${expansions[expansions.length - 1].target.slice(2)}`
                : "");
    }
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(`probe: outcome ${summary.outcome}: ${summary.reason}`);
    if (summary.firstUnmodeledHle) {
        console.log(`probe: first unmodeled HLE: ${summary.firstUnmodeledHle.replace(/^ppcx: /, "")}`);
    }
    console.log(`probe: summary ${path.join(outDir, "summary.json")}`);
    return 0;
}

function main() {
    try {
        const args = parseArgs(process.argv.slice(2));
        if (args.help !== undefined) {
            console.log(
                "usage: node tests/real/probe.js --rpx <U-King.rpx> --entry <addr> " +
                    "[--follow N] [--max N] [--budget N] [--iterations N] " +
                    "[--root <addr>]... [--root-table <addr> [--root-table-limit N]] " +
                    "[--expand-window <bytes>] [--image <blob>] [--out <dir>]"
            );
            return 0;
        }
        return runProbe(args);
    } catch (e) {
        console.error(`probe: ${e.message}`);
        return 1;
    }
}

if (require.main === module) process.exit(main());

module.exports = { runProbe };
