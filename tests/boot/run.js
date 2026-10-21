"use strict";

/**
 * Synthetic headless boot harness.
 *
 * Builds the game-free RPX fixture from tests/boot/fixture.js and runs it
 * through the real production path, in order:
 *
 *   1. `tools/ppcx` analysis discovers the function starts (the fixture
 *      asserts the exact authored list, including the pointer-only getter);
 *   2. `translateModule` emits the C unit (registry, entry and import names)
 *      from the analyzed module — the same function the `translate` command
 *      uses (verified byte-identical on the real v208 dump);
 *   3. `buildImage`/`serializeImage` write the load blob with the
 *      R_PPC_ADDR32 and TLS relocations applied;
 *   4. the real runtime, checked-memory model, image loader and HLE layer are
 *      compiled together with the generated unit and a small driver and
 *      booted headless (no game input, no window, no threads).
 *
 * Scenarios, each with the exact expected streams (stable checkpoints):
 *
 *   - boot:      entry -> memcpy -> helper -> address-taken OSBlockMove
 *                through the dispatcher trampoline; probes the .rodata
 *                relocations, the resolved TLS index and the guest writes;
 *   - tolerant:  an unmodeled import is a counted diagnostic no-op;
 *   - strict:    the same call stops with exit 5 and the register dump;
 *   - pointer:   a function only reachable through a .rodata code pointer;
 *   - tail:      a `b` that crosses into another range executes the mid-body
 *                entry point that the cross-range fixpoint discovered;
 *   - switch:    a computed bctr into an inline `b`-table whose entries the
 *                analysis promotes as table starts;
 *   - procui:    the five modeled proc_ui lifecycle calls run through the
 *                import substitution; the post-shutdown message pump must
 *                report EXITING (3) and the entry returns 0x47 from it;
 *   - fault:     a read outside every mapped region stops with exit 9;
 *   - no-image:  the same boot without PPCX_IMAGE faults at the first data
 *                read instead of silently reading zeroes.
 *
 * The boot scenario is run twice and must be byte-identical. `node
 * tests/boot/run.js` exits non-zero on any mismatch; compiler discovery is
 * shared with the ISA harness (PPCX_CC, then cc/gcc/clang/tcc).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildImage, serializeImage } = require("../../tools/ppcx/lib/image.js");
const ppcx = require("../../tools/ppcx/ppcx.js");
const fixture = require("./fixture.js");
const { findCompiler } = require("../isa/run.js");

const ROOT = path.resolve(__dirname, "..", "..");
const RUNTIME_INCLUDE = path.join(ROOT, "src", "runtime", "include");
const RUNTIME_SOURCES = [
    path.join(ROOT, "src", "runtime", "src", "ppcx_runtime.c"),
    path.join(ROOT, "src", "runtime", "src", "ppcx_mem.c"),
    path.join(ROOT, "src", "runtime", "src", "ppcx_hle.c"),
    path.join(ROOT, "src", "runtime", "src", "ppcx_image.c"),
];

const INITIAL_STACK = 0x10000000; /* PPCX_INITIAL_STACK */
const INITIAL_FRAME = 16; /* PPCX_INITIAL_FRAME: the loader's ABI frame */
const FIRST_SP = (INITIAL_STACK - INITIAL_FRAME) >>> 0;

function hex8(v) {
    return (v >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function lines(text) {
    return text.length === 0 ? [] : text.split(/\r?\n/).filter((l) => l.length > 0);
}

function dumpLine(r1, r2, r3, lr, ctr) {
    return (
        `      r1 0x${hex8(r1)}  r2 0x${hex8(r2)}  r3 0x${hex8(r3)}  ` +
        `lr 0x${hex8(lr)}  ctr 0x${hex8(ctr)}`
    );
}

/* ------------------------------------------------------------------ */
/* Scenario definition                                                 */
/* ------------------------------------------------------------------ */

function buildScenario() {
    const f = fixture.build();
    const rpx = ppcx.loadRpxFrom(f.buf, "<synthetic-boot.rpx>");
    const analysis = ppcx.computeAnalysis(rpx);
    const plan = buildImage(f.buf, rpx.parsed);
    const blob = serializeImage(plan);

    const e = f.expected;
    const translatedFunctions = 15; /* the seven authored entries plus the
                                      helper, the tail target, the three
                                      inline branch-table entries and the
                                      three switch case bodies */
    const imageLine =
        `ppcx: image <image> mapped: ${e.segments} segment(s), ${e.bytes} bytes (1 BSS)`;
    const entryLine = (addr) => `ppcx: entry 0x${hex8(addr)}, ${translatedFunctions} translated function(s)`;

    const initialProbes = e.probes;
    const bootProbes = initialProbes.map((p) => {
        switch (p.name) {
            case "data-1":
                return { ...p, value: 0x11223344 }; /* the boot entry's stw */
            case "bss-0":
            case "bss-16":
                return { ...p, value: 0x11223344 }; /* memcpy and OSBlockMove */
            default:
                return p;
        }
    });

    const probesToStdout = (probes, rc, calls) => [
        `boot rc=${rc}`,
        `boot hle-calls=${calls}`,
        ...probes.map((p) => `checkpoint ${p.name}=${hex8(p.value)}`),
    ];

    const scenarios = [
        {
            id: "boot",
            entry: e.entry.boot,
            env: { PPCX_HLE_TRACE: "1", PPCX_DISPATCH_TRACE: "1" },
            image: true,
            status: 0,
            stderr: [
                imageLine,
                entryLine(e.entry.boot),
                `ppcx: dispatch 0x${hex8(e.entry.boot)}`,
                "ppcx: HLE modeled #1: coreinit.memcpy (import 2), r3=0x00020300",
                "ppcx: dispatch 0x50000000", /* import trampoline (ADDR16 site) */
                "ppcx: HLE modeled #2: coreinit.OSBlockMove (import 0), r3=0x00020310",
                "ppcx: entry returned, r3 = 0x11223344",
                "ppcx: HLE calls: 2 (unimplemented services remain)",
            ],
            stdout: probesToStdout(bootProbes, 0, 2),
        },
        {
            id: "tolerant",
            entry: e.entry.strict,
            env: { PPCX_HLE_TRACE: "1" },
            image: true,
            status: 0,
            stderr: [
                imageLine,
                entryLine(e.entry.strict),
                "ppcx: HLE unimplemented #1: coreinit.OSSleepTicks (import 1) [diagnostic no-op]",
                "ppcx: entry returned, r3 = 0x00000001",
                "ppcx: HLE calls: 1 (unimplemented services remain)",
            ],
            stdout: probesToStdout(initialProbes, 0, 1),
        },
        {
            id: "strict",
            entry: e.entry.strict,
            env: { PPCX_HLE_STRICT: "1" },
            image: true,
            status: 5,
            stderr: [
                imageLine,
                entryLine(e.entry.strict),
                "ppcx: unimplemented HLE: coreinit.OSSleepTicks (import 1) in strict mode",
                dumpLine(FIRST_SP - 16, 0, 1, 0x000100a4, 0),
            ],
            stdout: [],
        },
        {
            id: "pointer",
            entry: e.entry.pointer,
            env: {},
            image: true,
            status: 0,
            stderr: [
                imageLine,
                entryLine(e.entry.pointer),
                "ppcx: entry returned, r3 = 0xAABBCCDD",
                "ppcx: HLE calls: 0 (unimplemented services remain)",
            ],
            stdout: probesToStdout(initialProbes, 0, 0),
        },
        {
            id: "tail",
            entry: e.entry.tail,
            env: { PPCX_DISPATCH_TRACE: "1" },
            image: true,
            status: 0,
            stderr: [
                imageLine,
                entryLine(e.entry.tail),
                `ppcx: dispatch 0x${hex8(e.entry.tail)}`,
                "ppcx: entry returned, r3 = 0x00000002",
                "ppcx: HLE calls: 0 (unimplemented services remain)",
            ],
            stdout: probesToStdout(initialProbes, 0, 0),
        },
        {
            id: "switch",
            entry: e.entry.switch,
            env: { PPCX_DISPATCH_TRACE: "1" },
            image: true,
            status: 0,
            stderr: [
                imageLine,
                entryLine(e.entry.switch),
                `ppcx: dispatch 0x${hex8(e.entry.switch)}`,
                `ppcx: dispatch 0x${hex8(e.tableStarts[0])}`,
                "ppcx: entry returned, r3 = 0x00000011",
                "ppcx: HLE calls: 0 (unimplemented services remain)",
            ],
            stdout: probesToStdout(initialProbes, 0, 0),
        },
        {
            id: "procui",
            entry: e.entry.procui,
            env: { PPCX_HLE_TRACE: "1" },
            image: true,
            status: 0,
            stderr: [
                imageLine,
                entryLine(e.entry.procui),
                "ppcx: HLE modeled #1: proc_ui.ProcUIInit (import 4), r3=0x00010048",
                "ppcx: HLE modeled #2: proc_ui.ProcUIRegisterCallback (import 6), r3=0x00000005",
                "ppcx: HLE modeled #3: proc_ui.ProcUIProcessMessages (import 5), r3=0x00000000",
                "ppcx: HLE modeled #4: proc_ui.ProcUIDrawDoneRelease (import 3), r3=0x00000000",
                "ppcx: HLE modeled #5: proc_ui.ProcUIProcessMessages (import 5), r3=0x00000000",
                "ppcx: HLE modeled #6: proc_ui.ProcUIShutdown (import 7), r3=0x00000000",
                "ppcx: HLE modeled #7: proc_ui.ProcUIProcessMessages (import 5), r3=0x00000003",
                "ppcx: entry returned, r3 = 0x00000047",
                "ppcx: HLE calls: 7 (unimplemented services remain)",
            ],
            stdout: probesToStdout(initialProbes, 0, 7),
        },
        {
            id: "fault",
            entry: e.entry.fault,
            env: {},
            image: true,
            status: 9,
            stderr: [
                imageLine,
                entryLine(e.entry.fault),
                "ppcx: guest memory fault: read of 4 byte(s) at 0x01000000 is not inside any mapped region",
                dumpLine(FIRST_SP - 16, 0, 0x01000000, 0, 0),
            ],
            stdout: [],
        },
        {
            id: "no-image",
            entry: e.entry.boot,
            env: {},
            image: false,
            status: 9,
            stderr: [
                entryLine(e.entry.boot),
                "ppcx: guest memory fault: read of 4 byte(s) at 0x00020100 is not inside any mapped region",
                dumpLine(FIRST_SP - 32, 0, 0x00020000, 0, 0),
            ],
            stdout: [],
        },
    ];

    return { f, rpx, analysis, plan, blob, translatedFunctions, scenarios };
}

/* ------------------------------------------------------------------ */
/* Generated C driver                                                  */
/* ------------------------------------------------------------------ */

function buildDriver(f) {
    const out = [];
    out.push("/* Generated by tests/boot/run.js. Synthetic data only. */");
    out.push('#include "ppcx_runtime.h"');
    out.push("#include <stdio.h>");
    out.push("");
    out.push("int main(void) {");
    out.push("    int rc = ppcx_run();");
    out.push('    printf("boot rc=%d\\n", rc);');
    out.push('    printf("boot hle-calls=%u\\n", ppcx_hle_call_count());');
    for (const p of f.expected.probes) {
        out.push(
            `    printf("checkpoint ${p.name}=%08X\\n", (unsigned)ppcx_rd32(0x${hex8(p.addr)}u));`
        );
    }
    out.push("    return rc;");
    out.push("}");
    out.push("");
    return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Compile and run                                                     */
/* ------------------------------------------------------------------ */

function compileEntry(compiler, workDir, entryId, genText, driverPath) {
    const genPath = path.join(workDir, `gen_${entryId}.c`);
    const exePath = path.join(workDir, `boot_${entryId}${process.platform === "win32" ? ".exe" : ""}`);
    fs.writeFileSync(genPath, genText);

    const args = [];
    if (!/(^|[\\/])tcc(\.exe)?$/i.test(compiler)) args.push("-std=c11", "-O0", "-Wall");
    args.push("-I", RUNTIME_INCLUDE, "-o", exePath, ...RUNTIME_SOURCES, genPath, driverPath, "-lm");
    let r = spawnSync(compiler, args, { encoding: "utf8" });
    if (r.status !== 0) {
        const retry = args.filter((a) => a !== "-lm");
        r = spawnSync(compiler, retry, { encoding: "utf8" });
        if (r.status !== 0) {
            throw new Error(
                `compiling the boot harness (${entryId}) failed\ncommand: ${compiler} ${retry.join(" ")}\n` +
                    `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`
            );
        }
    }
    return exePath;
}

function runBoot(opts = {}) {
    const compiler = opts.compiler !== undefined ? opts.compiler : findCompiler();
    if (!compiler) return { compiler: null, scenarios: 0, failures: [], skipped: true };

    const workDir = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), "ppcx-boot-"));
    const { f, rpx, analysis, plan, blob, scenarios } = buildScenario();
    const failures = [];

    /* Authored facts about the fixture must reach the real pipeline. */
    const wantStarts = f.expected.functionStarts;
    if (JSON.stringify(analysis.functionStarts) !== JSON.stringify(wantStarts)) {
        failures.push({
            id: "analysis.starts",
            detail: `expected ${JSON.stringify(wantStarts)}, got ${JSON.stringify(analysis.functionStarts)}`,
        });
    }
    if (JSON.stringify(analysis.pointerStarts) !== JSON.stringify(f.expected.pointerStarts)) {
        failures.push({
            id: "analysis.pointer-starts",
            detail: `expected ${JSON.stringify(f.expected.pointerStarts)}, got ${JSON.stringify(analysis.pointerStarts)}`,
        });
    }
    if (JSON.stringify(analysis.tableStarts) !== JSON.stringify(f.expected.tableStarts)) {
        failures.push({
            id: "analysis.table-starts",
            detail: `expected ${JSON.stringify(f.expected.tableStarts)}, got ${JSON.stringify(analysis.tableStarts)}`,
        });
    }
    if (JSON.stringify(analysis.tailStarts) !== JSON.stringify(f.expected.tailStarts)) {
        failures.push({
            id: "analysis.tail-starts",
            detail: `expected ${JSON.stringify(f.expected.tailStarts)}, got ${JSON.stringify(analysis.tailStarts)}`,
        });
    }
    if (analysis.coverage.unsupported !== 0 || analysis.coverage.unknown !== 0) {
        failures.push({
            id: "analysis.coverage",
            detail: `${analysis.coverage.unsupported} unsupported and ${analysis.coverage.unknown} unknown words`,
        });
    }
    const wantStats = {
        sections: f.expected.segments,
        bytes: f.expected.bytes,
        payloadBytes: f.expected.payloadBytes,
        bssBytes: f.expected.bssBytes,
    };
    for (const [key, value] of Object.entries(wantStats)) {
        if (plan.stats[key] !== value) {
            failures.push({ id: `image.stats.${key}`, detail: `expected ${value}, got ${plan.stats[key]}` });
        }
    }
    const applied = plan.relocations.applied;
    if (JSON.stringify(applied) !== JSON.stringify(f.expected.appliedRelocations)) {
        failures.push({ id: "image.applied", detail: JSON.stringify(applied) });
    }
    if (JSON.stringify(plan.tls.symbols) !== JSON.stringify(f.expected.tlsSymbols)) {
        failures.push({ id: "image.tls", detail: JSON.stringify(plan.tls.symbols) });
    }
    if (plan.relocations.code !== f.expected.codeRelocations) {
        failures.push({
            id: "image.code-relocations",
            detail: `expected ${f.expected.codeRelocations}, got ${plan.relocations.code}`,
        });
    }

    /* One translation per distinct entry; the registry is shared. */
    const roots = [
        f.expected.entry.boot,
        f.expected.entry.strict,
        f.expected.entry.fault,
        f.expected.entry.pointer,
        f.expected.entry.tail,
        f.expected.entry.switch,
        f.expected.entry.procui,
        /* The computed bctr target is invisible to the translator's static
         * callee walk, so the harness emits the discovered table entries as
         * explicit roots (same reason the pointer-only getter is a root). */
        ...f.expected.tableStarts,
    ];
    const translationByEntry = new Map();
    for (const scenario of scenarios) {
        if (translationByEntry.has(scenario.entry)) continue;
        translationByEntry.set(
            scenario.entry,
            ppcx.translateModule({ rpx, analysis, roots, entry: scenario.entry, follow: 1 })
        );
    }
    const reference = translationByEntry.get(f.expected.entry.boot);
    if (reference.report.totals.functions !== 15) {
        failures.push({
            id: "translate.functions",
            detail: `expected 15 translated functions, got ${reference.report.totals.functions}`,
        });
    }
    if (reference.report.totals.unsupportedInstructions !== 0 || reference.report.totals.warnings !== 0) {
        failures.push({
            id: "translate.totals",
            detail: `${reference.report.totals.unsupportedInstructions} unsupported, ${reference.report.totals.warnings} warnings`,
        });
    }
    if (reference.report.totals.instructions !== 120) {
        failures.push({
            id: "translate.instructions",
            detail: `expected 120 instructions, got ${reference.report.totals.instructions}`,
        });
    }
    const tailCall = `PPCX_TAILCALL(c, f_${hex8(f.expected.tailStarts[0])});`;
    if (!reference.gen.includes(tailCall)) {
        failures.push({ id: "translate.tail-target", detail: `gen.c does not contain ${tailCall}` });
    }
    const tableCall = `PPCX_TAILCALL(c, f_${hex8(f.expected.tailStarts[1])});`;
    if (!reference.gen.includes(tableCall)) {
        failures.push({
            id: "translate.table-target",
            detail: `gen.c does not contain ${tableCall} (the first table entry's case body)`,
        });
    }
    const wantHle = new Map([
        [0, { label: "coreinit.OSBlockMove", calls: 0, addressTaken: 1 }],
        [1, { label: "coreinit.OSSleepTicks", calls: 1, addressTaken: 0 }],
        [2, { label: "coreinit.memcpy", calls: 1, addressTaken: 0 }],
        [3, { label: "proc_ui.ProcUIDrawDoneRelease", calls: 1, addressTaken: 0 }],
        [4, { label: "proc_ui.ProcUIInit", calls: 1, addressTaken: 0 }],
        [5, { label: "proc_ui.ProcUIProcessMessages", calls: 3, addressTaken: 0 }],
        [6, { label: "proc_ui.ProcUIRegisterCallback", calls: 1, addressTaken: 0 }],
        [7, { label: "proc_ui.ProcUIShutdown", calls: 1, addressTaken: 0 }],
    ]);
    if (reference.report.hleImportsUsed.length !== wantHle.size) {
        failures.push({ id: "translate.hle", detail: JSON.stringify(reference.report.hleImportsUsed) });
    }
    for (const h of reference.report.hleImportsUsed) {
        const want = wantHle.get(h.index);
        if (
            !want ||
            `${h.module}.${h.name}` !== want.label ||
            h.calls !== want.calls ||
            h.addressTaken !== want.addressTaken
        ) {
            failures.push({ id: "translate.hle", detail: JSON.stringify(h) });
        }
    }

    const driverPath = path.join(workDir, "boot_main.c");
    fs.writeFileSync(driverPath, buildDriver(f));
    const imagePath = path.join(workDir, "boot-image.bin");
    fs.writeFileSync(imagePath, blob);

    const exeByEntry = new Map();
    const results = [];
    for (const scenario of scenarios) {
        const t = translationByEntry.get(scenario.entry);
        const genText = t.gen;
        const genEntryLine = `const u32 ppcx_entry = 0x${hex8(scenario.entry).toLowerCase()}u;`;
        if (!genText.includes(genEntryLine)) {
            failures.push({ id: `${scenario.id}.gen-entry`, detail: `gen.c does not contain ${genEntryLine}` });
        }
        if (!exeByEntry.has(scenario.entry)) {
            const id = `e${hex8(scenario.entry)}`;
            exeByEntry.set(
                scenario.entry,
                compileEntry(compiler, workDir, id, genText, driverPath)
            );
        }
        const exePath = exeByEntry.get(scenario.entry);
        const env = { ...process.env };
        delete env.PPCX_IMAGE;
        delete env.PPCX_HLE_TRACE;
        delete env.PPCX_HLE_STRICT;
        delete env.PPCX_DISPATCH_TRACE;
        delete env.PPCX_FN_TRACE;
        delete env.PPCX_CRASH_TRACE;
        Object.assign(env, scenario.env);
        if (scenario.image) env.PPCX_IMAGE = imagePath;

        const run = spawnSync(exePath, [], { encoding: "utf8", env });
        const stderr = lines(run.stderr).map((l) => (scenario.image ? l.split(imagePath).join("<image>") : l));
        const stdout = lines(run.stdout);
        results.push({ scenario, run, stderr, stdout });

        if (run.status !== scenario.status) {
            failures.push({
                id: `${scenario.id}.exit`,
                detail: `expected ${scenario.status}, got ${run.status}; stderr ${JSON.stringify(stderr)}`,
            });
        }
        const wantErr = scenario.stderr;
        if (stderr.length !== wantErr.length || stderr.some((l, i) => l !== wantErr[i])) {
            failures.push({
                id: `${scenario.id}.stderr`,
                detail: `expected ${JSON.stringify(wantErr)}, got ${JSON.stringify(stderr)}`,
            });
        }
        const wantOut = scenario.stdout;
        if (stdout.length !== wantOut.length || stdout.some((l, i) => l !== wantOut[i])) {
            failures.push({
                id: `${scenario.id}.stdout`,
                detail: `expected ${JSON.stringify(wantOut)}, got ${JSON.stringify(stdout)}`,
            });
        }
    }

    /* Determinism: the boot scenario twice, byte-identical on both streams. */
    const boot = results.find((r) => r.scenario.id === "boot");
    const bootExe = exeByEntry.get(f.expected.entry.boot);
    const env = { ...process.env, PPCX_IMAGE: imagePath, PPCX_HLE_TRACE: "1", PPCX_DISPATCH_TRACE: "1" };
    const repeat = spawnSync(bootExe, [], { encoding: "utf8", env });
    if (repeat.status !== boot.run.status || repeat.stdout !== boot.run.stdout || repeat.stderr !== boot.run.stderr) {
        failures.push({ id: "determinism", detail: "two runs of the boot scenario differed" });
    }

    const transcriptLines = results.reduce((n, r) => n + r.stderr.length, 0);
    const probeLines = results.reduce((n, r) => n + r.stdout.length, 0);
    return {
        compiler,
        scenarios: scenarios.length,
        entries: exeByEntry.size,
        transcriptLines,
        probeLines,
        failures,
        workDir,
    };
}

/* loadRpxFrom returns the parsed-module shape the pipeline works with; the
 * fixture is parsed once per run. */

function main() {
    const res = runBoot();
    if (!res.compiler) {
        console.log("boot: skipped, no C compiler found (set PPCX_CC to one)");
        return 0;
    }
    console.log(
        `boot: ${res.scenarios} scenarios (${res.entries} entries compiled), ` +
            `${res.transcriptLines} transcript lines, ${res.probeLines} memory probe lines, ` +
            `compiled with ${res.compiler}`
    );
    if (!res.failures.length) {
        console.log("boot: OK, the synthetic RPX boots headless with stable checkpoints");
        return 0;
    }
    console.log(`boot: ${res.failures.length} FAILURES`);
    for (const f of res.failures.slice(0, 10)) {
        console.log(`  ${f.id}: ${f.detail}`);
    }
    return 1;
}

if (require.main === module) process.exit(main());

module.exports = { runBoot, buildScenario };
