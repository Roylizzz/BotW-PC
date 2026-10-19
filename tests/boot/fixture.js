"use strict";

/**
 * Synthetic RPX fixture for the headless boot harness (tests/boot/run.js).
 *
 * Every byte is authored here; no game data is involved. The fixture is a
 * complete little module in the shapes real RPX modules use:
 *
 *   - `.text` with the boot entry, a helper reached through a direct `bl`, a
 *     strict-mode entry that calls an unmodeled import (`proc_ui.ProcUIInit`)
 *     and a fault entry that reads an unmapped address, plus a constant
 *     getter that only a `.rodata` code pointer can reach;
 *   - two `.fimport_*` sections whose symbols the `.rela.text` sites
 *     reference (`coreinit.memcpy`, `coreinit.OSBlockMove`,
 *     `proc_ui.ProcUIInit`), with one REL24 call site per function and an
 *     ADDR16_HA/LO pair for the address-taken `OSBlockMove`;
 *   - `.rodata` with three `R_PPC_ADDR32` pointers (one with an addend) and
 *     two deferred TLS relocations (`R_PPC_DTPMOD32`/`R_PPC_DTPREL32`),
 *     `.data` with authored words and a NOBITS `.bss`;
 *   - the allocated metadata trio (`.shstrtab`/`.symtab`/`.strtab`) and a
 *     non-allocated `.comment` that must not be mapped.
 *
 * The boot run proves the whole authored chain: analyze discovers the
 * authored starts, translate emits the registry and import names, image
 * applies the data relocations, and the real runtime + HLE layer runs it
 * headless with stable trace checkpoints and guest-memory effects.
 */

const TEXT_ADDR = 0x00010000;
const TEXT_SIZE = 0x000000e8;

const SLOT_MEMCPY = 0x00020000;
const SLOT_OSBLOCKMOVE = 0x00020008;
const SLOT_PROCUIINIT = 0x00020010;

const RODATA_ADDR = 0x00020100;
const RODATA_SIZE = 0x20;
const DATA_ADDR = 0x00020200;
const DATA_SIZE = 0x10;
const BSS_ADDR = 0x00020300;
const BSS_SIZE = 0x20;

/* Symbol indices in the authored .symtab (0 is the null entry). */
const SYM = {
    func_a: 1,
    func_h: 2,
    func_b: 3,
    func_c: 4,
    func_d: 5,
    data_obj: 6,
    memcpy: 7,
    OSBlockMove: 8,
    ProcUIInit: 9,
    tls_value: 10,
};

/* Entry points the harness boots, in the order the fixture authors them. */
const ENTRY = {
    boot: 0x00010000,
    helper: 0x00010048,
    strict: 0x00010090,
    fault: 0x000100b4,
    pointer: 0x000100d8,
};

/* ------------------------------------------------------------------ */
/* Minimal assembler (encodings straight from the ISA tables)          */
/* ------------------------------------------------------------------ */

function assemble() {
    const words = [];
    const labels = new Map();
    const relocs = []; // { offset, type, sym, addend } in .rela.text
    const patches = []; // label-based bl sites, resolved after emission

    const here = () => (TEXT_ADDR + words.length * 4) >>> 0;
    const api = {
        label(name) {
            labels.set(name, here());
            return api;
        },
        word(value) {
            words.push(value >>> 0);
            return api;
        },
        /* D-form */
        addi(rt, ra, imm) {
            return api.word(((14 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0);
        },
        addis(rt, ra, imm) {
            return api.word(((15 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0);
        },
        ori(ra, rs, imm) {
            return api.word(((24 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0);
        },
        lwz(rt, ra, d) {
            return api.word(((32 << 26) | (rt << 21) | (ra << 16) | (d & 0xffff)) >>> 0);
        },
        stw(rs, ra, d) {
            return api.word(((36 << 26) | (rs << 21) | (ra << 16) | (d & 0xffff)) >>> 0);
        },
        stwu(rs, ra, d) {
            return api.word(((37 << 26) | (rs << 21) | (ra << 16) | (d & 0xffff)) >>> 0);
        },
        /* Canonical system-register encodings (mflr r0 / mtlr rN / mtctr rN). */
        mflr() {
            return api.word(0x7c0802a6);
        },
        mtlr(rs = 0) {
            return api.word((0x7c0803a6 + (rs << 21)) >>> 0);
        },
        mtctr(rs) {
            return api.word((0x7c0903a6 + (rs << 21)) >>> 0);
        },
        /* bctrl: bcctr 20,0 with LK=1 */
        bctrl() {
            return api.word(0x4e800421);
        },
        blr() {
            return api.word(0x4e800020);
        },
        nop() {
            return api.ori(0, 0, 0);
        },
        /* Direct `bl` to a known absolute address (import slots). */
        blAbs(target, symIndex) {
            const site = here();
            const disp = (target - site) >>> 0;
            if (symIndex !== undefined) relocs.push({ offset: site, type: 10, sym: symIndex, addend: 0 });
            return api.word(((18 << 26) | (disp & 0x03fffffc) | 1) >>> 0);
        },
        /* Direct `bl` to a label emitted later; patched once all labels exist. */
        blLabel(label) {
            patches.push({ index: words.length, label });
            words.push(0);
            return api;
        },
        /* ADDR16_HA / ADDR16_LO pair taking the address of an import. */
        addisImport(rt, symIndex) {
            const site = here();
            api.addis(rt, 0, 0);
            relocs.push({ offset: (site + 2) >>> 0, type: 6, sym: symIndex, addend: 0 });
            return api;
        },
        addiImport(rt, symIndex) {
            const site = here();
            api.addi(rt, rt, 0);
            relocs.push({ offset: (site + 2) >>> 0, type: 4, sym: symIndex, addend: 0 });
            return api;
        },
        finish() {
            for (const p of patches) {
                const target = labels.get(p.label);
                if (target === undefined) throw new Error(`unresolved label ${p.label}`);
                const site = (TEXT_ADDR + p.index * 4) >>> 0;
                const disp = (target - site) >>> 0;
                words[p.index] = ((18 << 26) | (disp & 0x03fffffc) | 1) >>> 0;
            }
            return { words, labels, relocs };
        },
    };
    return api;
}

/* ------------------------------------------------------------------ */
/* Program                                                             */
/* ------------------------------------------------------------------ */

function buildText() {
    const a = assemble();

    /* Boot entry: follow a relocated .rodata pointer, patch .data through it,
     * then memcpy into .bss and let a helper move the copy once more. */
    a.label("func_a");
    a.stwu(1, 1, -32).mflr().stw(0, 1, 36);
    a.addis(3, 0, 0x0002).lwz(3, 3, 0x0100); /* r3 = *(0x20100): data_obj */
    a.lwz(4, 3, 0).stw(4, 3, 4); /* data[1] = data[0] */
    a.addis(4, 0, 0x0002).addi(4, 4, 0x0200); /* src = .data */
    a.addis(3, 0, 0x0002).addi(3, 3, 0x0300); /* dst = .bss */
    a.addi(5, 0, 4);
    a.blAbs(SLOT_MEMCPY, SYM.memcpy);
    a.blLabel("func_h");
    a.nop(); /* r3 already carries the helper's return value */
    a.mtlr().addi(1, 1, 32).blr();

    /* Helper: calls the address-taken OSBlockMove through the dispatcher's
     * import trampoline and returns the moved word. */
    a.label("func_h");
    a.stwu(1, 1, -16).mflr().stw(0, 1, 20);
    a.addis(3, 0, 0x0002).addi(3, 3, 0x0310); /* dst = .bss + 0x10 */
    a.addis(4, 0, 0x0002).addi(4, 4, 0x0300); /* src = .bss */
    a.addi(5, 0, 4);
    a.addisImport(12, SYM.OSBlockMove).addiImport(12, SYM.OSBlockMove);
    a.addi(6, 0, 1); /* flush hint: ignored on the coherent arena */
    a.mtctr(12).bctrl();
    a.lwz(3, 3, 0);
    a.lwz(0, 1, 20).mtlr().addi(1, 1, 16).blr();

    /* Strict-mode entry: calls an unmodeled import. */
    a.label("func_b");
    a.stwu(1, 1, -16).mflr().stw(0, 1, 20);
    a.addi(3, 0, 1);
    a.blAbs(SLOT_PROCUIINIT, SYM.ProcUIInit);
    a.lwz(0, 1, 20).mtlr().addi(1, 1, 16).blr();

    /* Fault entry: reads an address outside every mapped region. */
    a.label("func_c");
    a.stwu(1, 1, -16).mflr().stw(0, 1, 20);
    a.addis(3, 0, 0x0100); /* 0x01000000: arena hole between image and stack */
    a.lwz(4, 3, 0);
    a.lwz(0, 1, 20).mtlr().addi(1, 1, 16).blr();

    /* Pointer-only constant getter: no prologue, no branch reaches it. */
    a.label("func_d");
    a.addis(3, 0, 0x0002).lwz(3, 3, 0x0108); /* rodata[2] = data_obj + 8 */
    a.lwz(3, 3, 0); /* .data[2] */
    a.blr();

    return a.finish();
}

/* ------------------------------------------------------------------ */
/* ELF / RPX serialization                                             */
/* ------------------------------------------------------------------ */

const SECTION_TYPE = { PROGBITS: 1, SYMTAB: 2, STRTAB: 3, RELA: 4, NOBITS: 8 };

function writeU32(buf, offset, value) {
    buf.writeUInt32BE(value >>> 0, offset);
}

function writeU16(buf, offset, value) {
    buf.writeUInt16BE(value & 0xffff, offset);
}

function build() {
    const text = buildText();
    const labels = text.labels;

    /* Authored expectations: the assembler must land every function at the
     * address the harness boots, or the fixture is wrong and fails loudly. */
    const entries = {
        boot: labels.get("func_a"),
        helper: labels.get("func_h"),
        strict: labels.get("func_b"),
        fault: labels.get("func_c"),
        pointer: labels.get("func_d"),
    };
    for (const [name, addr] of Object.entries(ENTRY)) {
        if (entries[name] !== addr) {
            throw new Error(`fixture layout drifted: ${name} is 0x${entries[name].toString(16)}, expected 0x${addr.toString(16)}`);
        }
    }

    const textBytes = Buffer.alloc(TEXT_SIZE);
    text.words.forEach((w, i) => writeU32(textBytes, i * 4, w));
    if (text.words.length * 4 > TEXT_SIZE) throw new Error("program overflows .text");

    /* .rodata: two relocated pointers and a pointer with an addend, then the
     * two TLS slots the image tool must leave untouched. */
    const rodataBytes = Buffer.alloc(RODATA_SIZE);
    writeU32(rodataBytes, 0x00, DATA_ADDR); /* R_PPC_ADDR32 data_obj */
    writeU32(rodataBytes, 0x04, entries.pointer); /* R_PPC_ADDR32 func_d */
    writeU32(rodataBytes, 0x08, DATA_ADDR + 8); /* R_PPC_ADDR32 data_obj + 8 */
    writeU32(rodataBytes, 0x0c, 0xdddddddd); /* R_PPC_DTPMOD32 (deferred) */
    writeU32(rodataBytes, 0x10, 0xeeeeeeee); /* R_PPC_DTPREL32 (deferred) */

    const dataBytes = Buffer.alloc(DATA_SIZE);
    [0x11223344, 0x55667788, 0xaabbccdd, 0xdeadbeef].forEach((w, i) => writeU32(dataBytes, i * 4, w));

    /* Symbol and string tables. */
    const strtabChunks = [Buffer.from("\0", "ascii")];
    const strtabOffsets = new Map([["", 0]]);
    let strtabLen = 1;
    const addString = (name) => {
        const offset = strtabLen;
        const chunk = Buffer.from(name + "\0", "ascii");
        strtabChunks.push(chunk);
        strtabOffsets.set(name, offset);
        strtabLen += chunk.length;
        return offset;
    };
    const symbolDefs = [
        { name: "", value: 0, size: 0, info: 0, shndx: 0 },
        { name: "func_a", value: entries.boot, size: 0x48, info: 0x12, shndx: 1 },
        { name: "func_h", value: entries.helper, size: 0x48, info: 0x12, shndx: 1 },
        { name: "func_b", value: entries.strict, size: 0x24, info: 0x12, shndx: 1 },
        { name: "func_c", value: entries.fault, size: 0x24, info: 0x12, shndx: 1 },
        { name: "func_d", value: entries.pointer, size: 0x10, info: 0x12, shndx: 1 },
        { name: "data_obj", value: DATA_ADDR, size: DATA_SIZE, info: 0x11, shndx: 5 },
        { name: "memcpy", value: SLOT_MEMCPY, size: 8, info: 0x12, shndx: 2 },
        { name: "OSBlockMove", value: SLOT_OSBLOCKMOVE, size: 8, info: 0x12, shndx: 2 },
        { name: "ProcUIInit", value: SLOT_PROCUIINIT, size: 8, info: 0x12, shndx: 3 },
        { name: "tls_value", value: BSS_ADDR, size: 4, info: 0x11, shndx: 6 },
    ];
    for (const s of symbolDefs) {
        if (s.name !== "") addString(s.name);
    }
    const strtab = Buffer.concat(strtabChunks);
    const symtab = Buffer.alloc(symbolDefs.length * 16);
    symbolDefs.forEach((s, i) => {
        const o = i * 16;
        writeU32(symtab, o, strtabOffsets.get(s.name));
        writeU32(symtab, o + 4, s.value);
        writeU32(symtab, o + 8, s.size);
        symtab[o + 12] = s.info;
        symtab[o + 13] = 0;
        writeU16(symtab, o + 14, s.shndx);
    });

    /* Relocations: the three data pointers and the two deferred TLS sites. */
    const relaEntry = ({ offset, type, sym, addend }) => ({ offset, type, sym, addend: addend || 0 });
    const relaRoData = Buffer.alloc(5 * 12);
    [
        relaEntry({ offset: RODATA_ADDR + 0x00, type: 1, sym: SYM.data_obj, addend: 0 }),
        relaEntry({ offset: RODATA_ADDR + 0x04, type: 1, sym: SYM.func_d, addend: 0 }),
        relaEntry({ offset: RODATA_ADDR + 0x08, type: 1, sym: SYM.data_obj, addend: 8 }),
        relaEntry({ offset: RODATA_ADDR + 0x0c, type: 68, sym: SYM.tls_value, addend: 0 }),
        relaEntry({ offset: RODATA_ADDR + 0x10, type: 78, sym: SYM.tls_value, addend: 0 }),
    ].forEach((r, i) => {
        const o = i * 12;
        writeU32(relaRoData, o, r.offset);
        writeU32(relaRoData, o + 4, ((r.sym << 8) | (r.type & 0xff)) >>> 0);
        writeU32(relaRoData, o + 8, r.addend);
    });

    const relaText = Buffer.alloc(text.relocs.length * 12);
    text.relocs.forEach((r, i) => {
        const o = i * 12;
        writeU32(relaText, o, r.offset);
        writeU32(relaText, o + 4, ((r.sym << 8) | (r.type & 0xff)) >>> 0);
        writeU32(relaText, o + 8, r.addend);
    });

    const shstrNames = [
        "",
        ".text",
        ".fimport_coreinit",
        ".fimport_proc_ui",
        ".rodata",
        ".data",
        ".bss",
        ".shstrtab",
        ".symtab",
        ".strtab",
        ".rela.text",
        ".rela.rodata",
        ".comment",
    ];
    const shstrtab = Buffer.from("\0" + shstrNames.slice(1).join("\0") + "\0", "ascii");
    const shstrOffset = (name) => {
        if (name === "") return 0;
        const at = shstrtab.indexOf(Buffer.from(name + "\0", "ascii"), 1);
        if (at === -1) throw new Error(`section name ${name} is not in .shstrtab`);
        return at;
    };

    const sections = [
        { name: "", type: 0, flags: 0, addr: 0, data: Buffer.alloc(0), link: 0, info: 0, align: 0, entsize: 0 },
        { name: ".text", type: SECTION_TYPE.PROGBITS, flags: 0x6, addr: TEXT_ADDR, data: textBytes, link: 0, info: 0, align: 4 },
        { name: ".fimport_coreinit", type: SECTION_TYPE.PROGBITS, flags: 0x2, addr: SLOT_MEMCPY, data: Buffer.alloc(16), link: 0, info: 0, align: 8 },
        { name: ".fimport_proc_ui", type: SECTION_TYPE.PROGBITS, flags: 0x2, addr: SLOT_PROCUIINIT, data: Buffer.alloc(8), link: 0, info: 0, align: 8 },
        { name: ".rodata", type: SECTION_TYPE.PROGBITS, flags: 0x3, addr: RODATA_ADDR, data: rodataBytes, link: 0, info: 0, align: 4 },
        { name: ".data", type: SECTION_TYPE.PROGBITS, flags: 0x3, addr: DATA_ADDR, data: dataBytes, link: 0, info: 0, align: 4 },
        { name: ".bss", type: SECTION_TYPE.NOBITS, flags: 0x3, addr: BSS_ADDR, data: Buffer.alloc(0), size: BSS_SIZE, link: 0, info: 0, align: 4 },
        { name: ".shstrtab", type: SECTION_TYPE.STRTAB, flags: 0x2, addr: 0x00020400, data: shstrtab, link: 0, info: 0, align: 1 },
        { name: ".symtab", type: SECTION_TYPE.SYMTAB, flags: 0x2, addr: 0x00020500, data: symtab, link: 9, info: 1, align: 4, entsize: 16 },
        { name: ".strtab", type: SECTION_TYPE.STRTAB, flags: 0x2, addr: 0x00020600, data: strtab, link: 0, info: 0, align: 1 },
        { name: ".rela.text", type: SECTION_TYPE.RELA, flags: 0, addr: 0, data: relaText, link: 8, info: 1, align: 4, entsize: 12 },
        { name: ".rela.rodata", type: SECTION_TYPE.RELA, flags: 0, addr: 0, data: relaRoData, link: 8, info: 4, align: 4, entsize: 12 },
        { name: ".comment", type: SECTION_TYPE.PROGBITS, flags: 0, addr: 0, data: Buffer.from("#synthetic-boot\n\0", "ascii"), link: 0, info: 0, align: 1 },
    ];

    /* File layout: header, section payloads, then the section header table. */
    let cursor = 0x100;
    const placed = sections.map((s) => {
        const size = s.size !== undefined ? s.size : s.data.length;
        if (s.type === SECTION_TYPE.NOBITS) return { ...s, size, offset: 0 };
        const offset = Math.ceil(cursor / 4) * 4;
        cursor = offset + size;
        return { ...s, size, offset };
    });
    const shoff = Math.ceil(cursor / 4) * 4;
    const total = shoff + placed.length * 40;
    const buf = Buffer.alloc(total);

    /* ELF header (Wii U RPX conventions, same as tools/ppcx/tests/image-fixture.js). */
    buf[0] = 0x7f;
    buf[1] = 0x45;
    buf[2] = 0x4c;
    buf[3] = 0x46;
    buf[4] = 1; /* 32-bit */
    buf[5] = 2; /* big-endian */
    buf[6] = 1;
    buf[7] = 0xca;
    buf[8] = 0xfe;
    writeU16(buf, 16, 0xfe01); /* RPX custom e_type */
    writeU16(buf, 18, 20); /* EM_PPC */
    writeU32(buf, 20, 1);
    writeU32(buf, 24, ENTRY.boot);
    writeU32(buf, 28, 0);
    writeU32(buf, 32, shoff);
    writeU32(buf, 36, 0);
    writeU16(buf, 40, 52);
    writeU16(buf, 42, 0);
    writeU16(buf, 44, 0);
    writeU16(buf, 46, 40);
    writeU16(buf, 48, placed.length);
    writeU16(buf, 50, 7); /* .shstrtab */

    placed.forEach((s, i) => {
        if (s.type !== SECTION_TYPE.NOBITS && s.size > 0) s.data.copy(buf, s.offset);
        const at = shoff + i * 40;
        writeU32(buf, at, shstrOffset(s.name));
        writeU32(buf, at + 4, s.type);
        writeU32(buf, at + 8, s.flags);
        writeU32(buf, at + 12, s.addr);
        writeU32(buf, at + 16, s.offset);
        writeU32(buf, at + 20, s.size);
        writeU32(buf, at + 24, s.link || 0);
        writeU32(buf, at + 28, s.info || 0);
        writeU32(buf, at + 32, s.align || 1);
        writeU32(buf, at + 36, s.entsize || 0);
    });

    /* Authored mapped-segment facts: 9 allocated sections, one BSS. */
    const mapped = placed.filter((s) => (s.flags & 0x2) !== 0);
    const bytes = mapped.reduce((n, s) => n + s.size, 0);
    const bssBytes = mapped
        .filter((s) => s.type === SECTION_TYPE.NOBITS)
        .reduce((n, s) => n + s.size, 0);

    return {
        buf,
        layout: { shoff, sections: placed.length },
        entries,
        slots: { memcpy: SLOT_MEMCPY, OSBlockMove: SLOT_OSBLOCKMOVE, ProcUIInit: SLOT_PROCUIINIT },
        expected: {
            entry: ENTRY,
            text: { addr: TEXT_ADDR, size: TEXT_SIZE },
            rodata: { addr: RODATA_ADDR, size: RODATA_SIZE },
            data: { addr: DATA_ADDR, size: DATA_SIZE },
            bss: { addr: BSS_ADDR, size: BSS_SIZE },
            functionStarts: [ENTRY.boot, ENTRY.helper, ENTRY.strict, ENTRY.fault],
            pointerStarts: [ENTRY.pointer],
            segments: mapped.length,
            bytes,
            bssBytes,
            payloadBytes: bytes - bssBytes,
            appliedRelocations: [{ type: 1, name: "R_PPC_ADDR32", count: 3 }],
            deferredRelocations: [
                { addr: RODATA_ADDR + 0x0c, type: 68 },
                { addr: RODATA_ADDR + 0x10, type: 78 },
            ],
            codeRelocations: text.relocs.length,
            probes: [
                { name: "rodata-data-ptr", addr: RODATA_ADDR + 0x00, value: DATA_ADDR },
                { name: "rodata-func-ptr", addr: RODATA_ADDR + 0x04, value: ENTRY.pointer },
                { name: "rodata-data-plus8", addr: RODATA_ADDR + 0x08, value: DATA_ADDR + 8 },
                { name: "rodata-tls-mod", addr: RODATA_ADDR + 0x0c, value: 0xdddddddd },
                { name: "rodata-tls-off", addr: RODATA_ADDR + 0x10, value: 0xeeeeeeee },
                { name: "data-0", addr: DATA_ADDR + 0x00, value: 0x11223344 },
                { name: "data-1", addr: DATA_ADDR + 0x04, value: 0x55667788 },
                { name: "data-2", addr: DATA_ADDR + 0x08, value: 0xaabbccdd },
                { name: "bss-0", addr: BSS_ADDR + 0x00, value: 0x00000000 },
                { name: "bss-16", addr: BSS_ADDR + 0x10, value: 0x00000000 },
            ],
        },
    };
}

module.exports = { build, ENTRY, TEXT_ADDR, SLOT_MEMCPY, SLOT_OSBLOCKMOVE, SLOT_PROCUIINIT };
