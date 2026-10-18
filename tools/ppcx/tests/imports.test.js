"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { collectImports, buildImportMaps } = require("../lib/imports.js");

function fixture() {
    const parsed = {
        sections: [
            { index: 1, name: ".fimport_gx2", type: 1, flags: 0x2, addr: 0xc0000000, offset: 0x100, size: 0x10, logicalSize: 0x10 },
            { index: 2, name: ".dimport_os", type: 1, flags: 0x2, addr: 0xc0001000, offset: 0x120, size: 0x10, logicalSize: 0x10 },
            { index: 3, name: ".text", type: 1, flags: 0x4, addr: 0x02000020, offset: 0x200, size: 0x1000, logicalSize: 0x1000 },
        ],
    };
    const symbols = [
        { index: 0, name: "", value: 0, size: 0, type: 0, bind: 0, shndx: 0 },
        { index: 5, name: "GX2Init", value: 0xc0000000, size: 0, type: 2, bind: 1, shndx: 1 },
        { index: 6, name: "GX2Shutdown", value: 0xc0000008, size: 0, type: 2, bind: 1, shndx: 1 },
        { index: 7, name: "OSGetTime", value: 0xc0001000, size: 0, type: 1, bind: 1, shndx: 2 },
        { index: 8, name: "local_function", value: 0x02001000, size: 0, type: 2, bind: 0, shndx: 3 },
    ];
    const relocations = [
        { index: 0, offset: 0x02000100, type: 10, sym: 5, addend: 0 }, // call GX2Init
        { index: 1, offset: 0x02000104, type: 10, sym: 5, addend: 0 }, // call GX2Init
        { index: 2, offset: 0x02000108, type: 6, sym: 6, addend: 0 }, // &GX2Shutdown (HA)
        { index: 3, offset: 0x0200010a, type: 4, sym: 6, addend: 0 }, // &GX2Shutdown (LO)
        { index: 4, offset: 0x0200010c, type: 10, sym: 8, addend: 0 }, // internal call
        { index: 5, offset: 0x02000110, type: 6, sym: 7, addend: 0 }, // &OSGetTime
    ];
    return { parsed, symbols, relocations };
}

test("collects imports with call sites and address sites", () => {
    const { parsed, symbols, relocations } = fixture();
    const { imports, notes } = collectImports(parsed, symbols, relocations);
    assert.equal(imports.length, 3);
    const byName = new Map(imports.map((i) => [i.name, i]));
    const init = byName.get("GX2Init");
    assert.equal(init.module, "gx2");
    assert.equal(init.kind, "function");
    assert.equal(init.slot, 0xc0000000);
    assert.deepEqual(init.callSites, [0x02000100, 0x02000104]);
    const shutdown = byName.get("GX2Shutdown");
    assert.deepEqual(shutdown.addrSites.map((a) => a.type), [6, 4]);
    const getTime = byName.get("OSGetTime");
    assert.equal(getTime.kind, "data");
    assert.equal(getTime.module, "os");
    assert.equal(notes.callSites, 2);
    assert.equal(notes.addrSites, 3);
    assert.equal(notes.relocationsSkipped, 1);
});

test("imports are sorted by module and name with stable indices", () => {
    const { parsed, symbols, relocations } = fixture();
    const { imports } = collectImports(parsed, symbols, relocations);
    assert.deepEqual(
        imports.map((i) => `${i.module}.${i.name}`),
        ["gx2.GX2Init", "gx2.GX2Shutdown", "os.OSGetTime"]
    );
    assert.deepEqual(imports.map((i) => i.index), [0, 1, 2]);
});

test("builds call-site and data-site maps", () => {
    const { parsed, symbols, relocations } = fixture();
    const { imports } = collectImports(parsed, symbols, relocations);
    const { callSite, dataSite } = buildImportMaps(imports);
    const init = imports.find((i) => i.name === "GX2Init");
    assert.equal(callSite.get(0x02000100), init.index);
    assert.equal(callSite.has(0x0200010c), false); // internal call stays unmapped
    const shutdown = imports.find((i) => i.name === "GX2Shutdown");
    assert.equal(dataSite.get(0x02000108).index, shutdown.index);
    assert.equal(dataSite.get(0x02000108).type, 6);
    assert.equal(dataSite.get(0x0200010a).type, 4);
});
