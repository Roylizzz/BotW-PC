"use strict";

/**
 * Synthetic RPX fixture for the load-image tests (tools/ppcx/lib/image.js and
 * tests/loader). Every byte is authored here; no game data is involved.
 *
 * On purpose the fixture carries:
 *   - a zlib-compressed .rodata and a NOBITS .bss (zero-fill on load),
 *   - ADDR32 relocations in .rodata and .data (must be applied),
 *   - DTPMOD32 / DTPREL32 TLS relocations in .rodata (must be applied),
 *   - one REL24 site in .text (the recompiler's business, left untouched),
 *   - the allocated metadata trio (.shstrtab/.symtab/.strtab) real modules
 *     carry,
 *   - a non-allocated .comment section that must not be mapped.
 */

const zlib = require("zlib");

/* Authored payloads (all game-free). */
const TEXT_WORD0 = 0x10111213; /* bytes 0x10,0x11,... one per byte */
const RODATA_WORDS = [0x11223344, 0x55667788, 0xa8a9aaab, 0xacadaeaf];
const DATA_BYTES = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];

const SECTION_NAMES = [
    "",
    ".text",
    ".rodata",
    ".data",
    ".bss",
    ".comment",
    ".shstrtab",
    ".symtab",
    ".strtab",
    ".rela.text",
    ".rela.rodata",
    ".rela.data",
];

const CONTENT = {
    text: 0x300,
    rodata: 0x400,
    data: 0x500,
    comment: 0x520,
    shstrtab: 0x600,
    symtab: 0x700,
    strtab: 0x780,
    relaText: 0x800,
    relaRoData: 0x820,
    relaData: 0x850,
};
const TOTAL = 0x860;

function writeU32(buf, offset, value) {
    buf.writeUInt32BE(value >>> 0, offset);
}

function writeU16(buf, offset, value) {
    buf.writeUInt16BE(value & 0xffff, offset);
}

function build() {
    const textPayload = Buffer.alloc(64);
    for (let i = 0; i < textPayload.length; i++) textPayload[i] = (0x10 + i) & 0xff;

    const rodataOnDisk = Buffer.alloc(16);
    RODATA_WORDS.forEach((w, i) => writeU32(rodataOnDisk, i * 4, w));

    const deflated = zlib.deflateSync(rodataOnDisk, { level: 9 });
    const rodataFile = Buffer.concat([Buffer.alloc(4), deflated]);
    writeU32(rodataFile, 0, rodataOnDisk.length);

    const dataOnDisk = Buffer.from(DATA_BYTES);
    const comment = Buffer.from("#synth\n\0", "ascii");

    const shstr = Buffer.from(
        `\0${SECTION_NAMES.slice(1).join("\0")}\0`,
        "ascii"
    );
    const strtab = Buffer.from("\0func_a\0data_obj\0tls_value\0", "ascii");

    const symtab = Buffer.alloc(4 * 16);
    let o = 16;
    writeU32(symtab, o, 1); /* func_a */
    writeU32(symtab, o + 4, 0x00010010);
    writeU32(symtab, o + 8, 8);
    symtab[o + 12] = (1 << 4) | 2; /* GLOBAL FUNC */
    writeU16(symtab, o + 14, 1);
    o = 32;
    writeU32(symtab, o, 8); /* data_obj */
    writeU32(symtab, o + 4, 0x00020100);
    writeU32(symtab, o + 8, 8);
    symtab[o + 12] = (1 << 4) | 1; /* GLOBAL OBJECT */
    writeU16(symtab, o + 14, 3);
    o = 48;
    writeU32(symtab, o, 17); /* tls_value */
    writeU32(symtab, o + 4, 0); /* TLS symbol value is an offset, not an address */
    writeU32(symtab, o + 8, 4);
    symtab[o + 12] = (1 << 4) | 6; /* GLOBAL TLS */
    writeU16(symtab, o + 14, 4);

    const writeRela = (buf, offset, { offset: site, type, sym, addend }) => {
        writeU32(buf, offset, site);
        writeU32(buf, offset + 4, ((sym << 8) | (type & 0xff)) >>> 0);
        writeU32(buf, offset + 8, addend);
    };

    const relaText = Buffer.alloc(12);
    writeRela(relaText, 0, { offset: 0x00010004, type: 10, sym: 1, addend: 0 });

    const relaRoData = Buffer.alloc(48);
    writeRela(relaRoData, 0, { offset: 0x00020000, type: 1, sym: 1, addend: 0 });
    writeRela(relaRoData, 12, { offset: 0x00020004, type: 1, sym: 2, addend: 4 });
    writeRela(relaRoData, 24, { offset: 0x00020008, type: 68, sym: 3, addend: 0 });
    writeRela(relaRoData, 36, { offset: 0x0002000c, type: 78, sym: 3, addend: 4 });

    const relaData = Buffer.alloc(12);
    writeRela(relaData, 0, { offset: 0x00020100, type: 1, sym: 2, addend: 0 });

    const buf = Buffer.alloc(TOTAL);

    /* --- ELF header --- */
    buf[0] = 0x7f;
    buf[1] = 0x45;
    buf[2] = 0x4c;
    buf[3] = 0x46;
    buf[4] = 1; /* 32-bit */
    buf[5] = 2; /* big-endian */
    buf[6] = 1;
    buf[7] = 0xca; /* Wii U OSABI convention */
    buf[8] = 0xfe;
    writeU16(buf, 16, 0xfe01); /* RPX custom e_type */
    writeU16(buf, 18, 20); /* EM_PPC */
    writeU32(buf, 20, 1);
    writeU32(buf, 24, 0x00010000); /* e_entry */
    writeU32(buf, 28, 0);
    writeU32(buf, 32, 64); /* e_shoff */
    writeU32(buf, 36, 0);
    writeU16(buf, 40, 52);
    writeU16(buf, 42, 0);
    writeU16(buf, 44, 0);
    writeU16(buf, 46, 40);
    writeU16(buf, 48, SECTION_NAMES.length);
    writeU16(buf, 50, 6); /* e_shstrndx */

    const shoff = 64;
    const sh = (name) => shoff + SECTION_NAMES.indexOf(name) * 40;
    const setSection = (name, { type, flags, addr, offset, size, link, info, align, entsize }) => {
        const at = sh(name);
        writeU32(buf, at, shstr.indexOf(SECTION_NAMES[SECTION_NAMES.indexOf(name)])); /* name offset */
        writeU32(buf, at + 4, type);
        writeU32(buf, at + 8, flags);
        writeU32(buf, at + 12, addr);
        writeU32(buf, at + 16, offset);
        writeU32(buf, at + 20, size);
        writeU32(buf, at + 24, link || 0);
        writeU32(buf, at + 28, info || 0);
        writeU32(buf, at + 32, align || 1);
        writeU32(buf, at + 36, entsize || 0);
    };

    setSection(".text", { type: 1, flags: 0x6, addr: 0x00010000, offset: CONTENT.text, size: textPayload.length, align: 4 });
    setSection(".rodata", { type: 1, flags: 0x08000003, addr: 0x00020000, offset: CONTENT.rodata, size: rodataFile.length, align: 4 });
    setSection(".data", { type: 1, flags: 0x3, addr: 0x00020100, offset: CONTENT.data, size: dataOnDisk.length, align: 4 });
    /* 0x04000000 mimics the extra flag real modules put on thread BSS. */
    setSection(".bss", { type: 8, flags: 0x04000003, addr: 0x00020200, offset: 0, size: 32, align: 4 });
    setSection(".comment", { type: 1, flags: 0, addr: 0, offset: CONTENT.comment, size: comment.length, align: 1 });
    setSection(".shstrtab", { type: 3, flags: 0x2, addr: 0x00020300, offset: CONTENT.shstrtab, size: shstr.length, align: 1 });
    setSection(".symtab", { type: 2, flags: 0x2, addr: 0x00020400, offset: CONTENT.symtab, size: symtab.length, link: 8, info: 1, align: 4, entsize: 16 });
    setSection(".strtab", { type: 3, flags: 0x2, addr: 0x00020500, offset: CONTENT.strtab, size: strtab.length, align: 1 });
    setSection(".rela.text", { type: 4, flags: 0, addr: 0, offset: CONTENT.relaText, size: relaText.length, link: 7, info: 1, align: 4, entsize: 12 });
    setSection(".rela.rodata", { type: 4, flags: 0, addr: 0, offset: CONTENT.relaRoData, size: relaRoData.length, link: 7, info: 2, align: 4, entsize: 12 });
    setSection(".rela.data", { type: 4, flags: 0, addr: 0, offset: CONTENT.relaData, size: relaData.length, link: 7, info: 3, align: 4, entsize: 12 });

    textPayload.copy(buf, CONTENT.text);
    rodataFile.copy(buf, CONTENT.rodata);
    dataOnDisk.copy(buf, CONTENT.data);
    comment.copy(buf, CONTENT.comment);
    shstr.copy(buf, CONTENT.shstrtab);
    symtab.copy(buf, CONTENT.symtab);
    strtab.copy(buf, CONTENT.strtab);
    relaText.copy(buf, CONTENT.relaText);
    relaRoData.copy(buf, CONTENT.relaRoData);
    relaData.copy(buf, CONTENT.relaData);

    /* Expected bytes after relocation is applied. */
    const rodataAfterRelocs = Buffer.from(rodataOnDisk);
    writeU32(rodataAfterRelocs, 0, 0x00010010); /* ADDR32 func_a + 0 */
    writeU32(rodataAfterRelocs, 4, 0x00020104); /* ADDR32 data_obj + 4 */
    writeU32(rodataAfterRelocs, 8, 1); /* DTPMOD32: main module id */
    writeU32(rodataAfterRelocs, 12, 4); /* DTPREL32: tls_value + 4 */

    const dataAfterRelocs = Buffer.from(dataOnDisk);
    writeU32(dataAfterRelocs, 0, 0x00020100); /* ADDR32 data_obj + 0 */

    const segments = [
        { name: ".text", addr: 0x00010000, size: 64, bss: false, write: false },
        { name: ".rodata", addr: 0x00020000, size: 16, bss: false, write: true },
        { name: ".data", addr: 0x00020100, size: 8, bss: false, write: true },
        { name: ".bss", addr: 0x00020200, size: 32, bss: true, write: true },
        { name: ".shstrtab", addr: 0x00020300, size: shstr.length, bss: false, write: false },
        { name: ".symtab", addr: 0x00020400, size: 64, bss: false, write: false },
        { name: ".strtab", addr: 0x00020500, size: strtab.length, bss: false, write: false },
    ];
    const bytes = segments.reduce((n, s) => n + s.size, 0);

    return {
        buf,
        layout: {
            shoff,
            sectionHeader: (name) => shoff + SECTION_NAMES.indexOf(name) * 40,
            relaEntry: (name, i) => CONTENT[name === ".rela.text" ? "relaText" : name === ".rela.rodata" ? "relaRoData" : "relaData"] + i * 12,
        },
        expected: {
            textPayload,
            rodataOnDisk,
            rodataAfterRelocs,
            dataAfterRelocs,
            segments,
            stats: { sections: segments.length, bytes, payloadBytes: bytes - 32, bssBytes: 32 },
            probes: [
                [0x00020000, 0x00010010],
                [0x00020004, 0x00020104],
                [0x00020008, 0x00000001], /* DTPMOD32: main module id */
                [0x0002000c, 0x00000004], /* DTPREL32: tls_value + 4 */
                [0x00020100, 0x00020100],
                [0x00010000, TEXT_WORD0],
                [0x00020204, 0x00000000], /* .bss zero-filled over the sentinel */
            ],
            applied: [
                { type: 1, name: "R_PPC_ADDR32", count: 3 },
                { type: 68, name: "R_PPC_DTPMOD32", count: 1 },
                { type: 78, name: "R_PPC_DTPREL32", count: 1 },
            ],
            tlsSymbols: [{ name: "tls_value", offset: 4, size: 4 }],
            codeRelocations: 1,
        },
    };
}

/** Writes one Elf32_Rela record at a file offset (test helper). */
function patchRela(buf, fileOffset, { offset, type, sym, addend }) {
    buf.writeUInt32BE(offset >>> 0, fileOffset);
    buf.writeUInt32BE((((sym >>> 0) << 8) | (type & 0xff)) >>> 0, fileOffset + 4);
    buf.writeUInt32BE(addend >>> 0, fileOffset + 8);
}

/** Rewrites the sh_addr field of a section header (test helper). */
function patchSectionAddr(buf, layout, name, addr) {
    buf.writeUInt32BE(addr >>> 0, layout.sectionHeader(name) + 12);
}

/** Rewrites fields of one Elf32_Sym entry (test helper). */
function patchSymbol(buf, layout, index, { value, size, info, shndx }) {
    const symtabOffset = buf.readUInt32BE(layout.sectionHeader(".symtab") + 16);
    const at = symtabOffset + index * 16;
    if (value !== undefined) buf.writeUInt32BE(value >>> 0, at + 4);
    if (size !== undefined) buf.writeUInt32BE(size >>> 0, at + 8);
    if (info !== undefined) buf[at + 12] = info & 0xff;
    if (shndx !== undefined) buf.writeUInt16BE(shndx & 0xffff, at + 14);
}

module.exports = { build, patchRela, patchSectionAddr, patchSymbol };
