"use strict";

/**
 * Import table extraction for RPX modules.
 *
 * The RPX layout the Wii U loader understands:
 *
 *   - `.fimport_<library>` sections hold one 8-byte slot per imported
 *     function. The loader writes the resolved function address into the
 *     slot at load time. The file leaves the slots zeroed.
 *   - `.dimport_<library>` sections do the same for imported data.
 *   - Relocations in `.rela.text` reference the *symbols* of those imports:
 *       - R_PPC_REL24 (10) at a `bl`/`b` instruction = a direct call to the
 *         import. The instruction's stored displacement is a build-time
 *         placeholder, the loader repoints it.
 *       - R_PPC_ADDR16_HA/LO/HI (6/4/5) at a `lis`/`addi` pair = the address
 *         of the import is taken (the loader gives out a trampoline).
 *
 * `collectImports` turns symbols + relocations into a stable, sorted import
 * list with call sites and address-taken sites. Call sites are what the
 * translator uses to substitute named HLE calls.
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

const RPX_CALL = 10; // R_PPC_REL24
const ADDR16_TYPES = new Set([4, 5, 6]); // R_PPC_ADDR16_LO / _HI / _HA

function sectionNameFor(parsed, value) {
    const sections = parsed.sections || [];
    for (const s of sections) {
        const size = (s.logicalSize !== undefined ? s.logicalSize : s.size) >>> 0;
        if (size > 0 && value >= (s.addr >>> 0) && value < ((s.addr >>> 0) + size)) return s.name;
    }
    return null;
}

/**
 * @param {object} parsed  result of rpxinfo's parseRpx()
 * @param {Array}  symbols result of rpxinfo's readSymbols()
 * @param {Array}  relocations entries of rpxinfo's readRelocations(".rela.text")
 * @returns {{ imports: Array, notes: object }}
 */
function collectImports(parsed, symbols, relocations) {
    const byIndex = new Map(symbols.map((s) => [s.index, s]));
    const byKey = new Map(); // slot address -> import record

    function importForSymbol(sym) {
        if (!sym || !sym.name) return null;
        const sectionName = sectionNameFor(parsed, sym.value >>> 0);
        if (!sectionName) return null;
        if (!sectionName.startsWith(".fimport_") && !sectionName.startsWith(".dimport_")) return null;
        const module = sectionName.replace(/^\.(f|d)import_/, "");
        const isFunction = sectionName.startsWith(".fimport_");
        let rec = byKey.get(sym.value >>> 0);
        if (!rec) {
            rec = {
                module,
                name: sym.name,
                kind: isFunction ? "function" : "data",
                slot: sym.value >>> 0,
                callSites: [],
                addrSites: [],
            };
            byKey.set(sym.value >>> 0, rec);
        }
        return rec;
    }

    let skipped = 0;
    for (const r of relocations) {
        const sym = byIndex.get(r.sym);
        const rec = importForSymbol(sym);
        if (!rec) {
            skipped++;
            continue;
        }
        if (r.type === RPX_CALL) rec.callSites.push(r.offset >>> 0);
        else if (ADDR16_TYPES.has(r.type)) rec.addrSites.push({ offset: r.offset >>> 0, type: r.type });
    }

    const imports = [...byKey.values()].sort((a, b) => {
        if (a.module !== b.module) return a.module < b.module ? -1 : 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    for (let i = 0; i < imports.length; i++) imports[i].index = i;

    const callCount = imports.reduce((n, im) => n + im.callSites.length, 0);
    const addrCount = imports.reduce((n, im) => n + im.addrSites.length, 0);
    return {
        imports,
        notes: {
            total: imports.length,
            functions: imports.filter((i) => i.kind === "function").length,
            data: imports.filter((i) => i.kind === "data").length,
            callSites: callCount,
            addrSites: addrCount,
            relocationsSkipped: skipped,
        },
    };
}

/**
 * Maps used by the translator:
 *   callSite -> import index    (REL24 sites)
 *   dataSite -> { index, type, kind } (ADDR16 sites)
 *
 * `kind` is essential: a function import is addressable through a dispatcher
 * trampoline, while a data import must resolve to the storage address that
 * coreinit supplies. The translator must never route a data import through
 * the function trampoline.
 */
function buildImportMaps(imports) {
    const callSite = new Map();
    const dataSite = new Map();
    for (const im of imports) {
        for (const off of im.callSites) callSite.set(off, im.index);
        for (const a of im.addrSites) {
            dataSite.set(a.offset, { index: im.index, type: a.type, kind: im.kind });
        }
    }
    return { callSite, dataSite };
}

module.exports = { collectImports, buildImportMaps };
