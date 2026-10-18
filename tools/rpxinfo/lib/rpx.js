"use strict";

/**
 * Original, minimal reader for Wii U RPX/RPL executables.
 *
 * RPX/RPL are modified ELF32 big-endian objects:
 *   - no program headers (the loader uses the section headers);
 *   - sections with flag SHF_RPL_ZLIB (0x08000000) store a 4-byte
 *     big-endian uncompressed size followed by a zlib stream;
 *   - dynamic-linking exports/imports live in dedicated sections.
 *
 * Public documentation: https://wiiubrew.org/wiki/RPL
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

const zlib = require("zlib");

const ELF_MAGIC = 0x7f454c46;
const EM_PPC = 20;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHF_RPL_ZLIB = 0x08000000;

const SHT_SYMTAB = 0x2;
const SHT_STRTAB = 0x3;
const SHT_NOBITS = 0x8;

const SECTION_TYPES = {
  0x0: "NULL",
  0x1: "PROGBITS",
  0x2: "SYMTAB",
  0x3: "STRTAB",
  0x4: "RELA",
  0x5: "HASH",
  0x6: "DYNAMIC",
  0x7: "NOTE",
  0x8: "NOBITS",
  0x9: "REL",
  0xa: "SHLIB",
  0xb: "DYNSYM",
};

const SYMBOL_TYPES = {
  0x0: "NOTYPE",
  0x1: "OBJECT",
  0x2: "FUNC",
  0x3: "SECTION",
  0x4: "FILE",
  0x5: "COMMON",
  0x6: "TLS",
};

const SYMBOL_BINDINGS = {
  0x0: "LOCAL",
  0x1: "GLOBAL",
  0x2: "WEAK",
};

class RpxError extends Error {}

function parseHeader(buf) {
  if (buf.length < 52) throw new RpxError("file too small to contain an ELF header");
  if (buf.readUInt32BE(0) !== ELF_MAGIC) throw new RpxError("not an ELF file (bad magic)");
  if (buf[4] !== 1) throw new RpxError(`unsupported ELF class ${buf[4]} (expected 32-bit)`);
  if (buf[5] !== 2) throw new RpxError(`unsupported ELF endianness ${buf[5]} (expected big-endian)`);
  const e_machine = buf.readUInt16BE(18);
  if (e_machine !== EM_PPC) {
    throw new RpxError(`unsupported e_machine ${e_machine} (expected PowerPC = 20)`);
  }
  return {
    ei_class: buf[4],
    ei_data: buf[5],
    ei_version: buf[6],
    ei_osabi: buf[7],
    ei_abiversion: buf[8],
    e_type: buf.readUInt16BE(16),
    e_machine,
    e_version: buf.readUInt32BE(20),
    e_entry: buf.readUInt32BE(24),
    e_phoff: buf.readUInt32BE(28),
    e_shoff: buf.readUInt32BE(32),
    e_flags: buf.readUInt32BE(36),
    e_ehsize: buf.readUInt16BE(40),
    e_phentsize: buf.readUInt16BE(42),
    e_phnum: buf.readUInt16BE(44),
    e_shentsize: buf.readUInt16BE(46),
    e_shnum: buf.readUInt16BE(48),
    e_shstrndx: buf.readUInt16BE(50),
  };
}

function parseSectionAt(buf, offset) {
  return {
    nameOffset: buf.readUInt32BE(offset),
    type: buf.readUInt32BE(offset + 4),
    flags: buf.readUInt32BE(offset + 8),
    addr: buf.readUInt32BE(offset + 12),
    offset: buf.readUInt32BE(offset + 16),
    size: buf.readUInt32BE(offset + 20),
    link: buf.readUInt32BE(offset + 24),
    info: buf.readUInt32BE(offset + 28),
    addralign: buf.readUInt32BE(offset + 32),
    entsize: buf.readUInt32BE(offset + 36),
  };
}

function readCString(buf, start) {
  let end = start;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString("utf8", start, end);
}

function sectionTypeName(type) {
  return SECTION_TYPES[type] ?? `0x${type.toString(16)}`;
}

function sectionFlagsHuman(flags) {
  const parts = [];
  if (flags & SHF_WRITE) parts.push("WRITE");
  if (flags & SHF_ALLOC) parts.push("ALLOC");
  if (flags & SHF_EXECINSTR) parts.push("EXEC");
  if (flags & SHF_RPL_ZLIB) parts.push("RPL_ZLIB");
  const known = SHF_WRITE | SHF_ALLOC | SHF_EXECINSTR | SHF_RPL_ZLIB;
  const rest = flags & ~known;
  if (rest) parts.push(`0x${rest.toString(16)}`);
  return parts.join("|") || "-";
}

function symbolTypeName(type) {
  return SYMBOL_TYPES[type] ?? `0x${type.toString(16)}`;
}

function symbolBindingName(bind) {
  return SYMBOL_BINDINGS[bind] ?? `0x${bind.toString(16)}`;
}

function readSectionData(buf, section) {
  if (section.size === 0) {
    return { data: Buffer.alloc(0), compressed: false, compressedSize: 0, declaredSize: 0 };
  }
  if (section.type === SHT_NOBITS) {
    // NOBITS sections occupy no file space (e.g. .bss).
    return { data: Buffer.alloc(section.size), compressed: false, compressedSize: 0, declaredSize: section.size };
  }
  const raw = buf.subarray(section.offset, section.offset + section.size);
  if (raw.length !== section.size) throw new RpxError(`section ${section.index} data is out of range`);
  if (section.flags & SHF_RPL_ZLIB) {
    if (raw.length < 4) throw new RpxError(`compressed section ${section.index} is too small`);
    const declaredSize = raw.readUInt32BE(0);
    let data;
    try {
      data = zlib.inflateSync(raw.subarray(4));
    } catch (e) {
      throw new RpxError(`section ${section.index} failed to inflate: ${e.message}`);
    }
    return { data, compressed: true, compressedSize: raw.length, declaredSize };
  }
  return { data: Buffer.from(raw), compressed: false, compressedSize: raw.length, declaredSize: raw.length };
}

function parseRpx(buf) {
  const header = parseHeader(buf);
  const sections = [];
  for (let i = 0; i < header.e_shnum; i++) {
    const offset = header.e_shoff + i * header.e_shentsize;
    if (offset + 40 > buf.length) throw new RpxError(`section header ${i} is out of range`);
    sections.push({ index: i, ...parseSectionAt(buf, offset) });
  }
  // The section-name string table may itself be compressed.
  const strSection = sections[header.e_shstrndx];
  if (strSection && strSection.size > 0) {
    const { data } = readSectionData(buf, strSection);
    for (const s of sections) {
      s.name = s.nameOffset < data.length ? readCString(data, s.nameOffset) : "";
    }
  } else {
    for (const s of sections) s.name = "";
  }
  // Logical size: decompressed size for zlib sections, raw size otherwise.
  for (const s of sections) {
    if ((s.flags & SHF_RPL_ZLIB) && s.type !== SHT_NOBITS && s.size >= 4) {
      s.logicalSize = buf.readUInt32BE(s.offset);
    } else {
      s.logicalSize = s.size;
    }
  }
  return { header, sections };
}

function findSection(parsed, selector) {
  const text = String(selector);
  if (/^\d+$/.test(text)) {
    const byIndex = parsed.sections[Number(text)];
    return byIndex ?? null;
  }
  const plain = text.startsWith(".") ? text : `.${text}`;
  return parsed.sections.find((s) => s.name === plain) ?? null;
}

function addrToSection(parsed, addr) {
  return (
    parsed.sections.find((s) => s.logicalSize > 0 && addr >= s.addr && addr < s.addr + s.logicalSize) ?? null
  );
}

/**
 * Reads the symbol table (.symtab) using the standard 16-byte Elf32_Sym
 * layout: st_name(4), st_value(4), st_size(4), st_info(1), st_other(1),
 * st_shndx(2). Names are resolved through the linked string table.
 */
function readSymbols(buf, parsed) {
  const symtab = parsed.sections.find((s) => s.type === SHT_SYMTAB);
  if (!symtab) return [];
  const { data: symData } = readSectionData(buf, symtab);
  const strtab = parsed.sections[symtab.link];
  const strData =
    strtab && strtab.type === SHT_STRTAB ? readSectionData(buf, strtab).data : Buffer.alloc(0);
  const entsize = symtab.entsize > 0 ? symtab.entsize : 16;
  const count = Math.floor(symData.length / entsize);
  const symbols = [];
  for (let i = 0; i < count; i++) {
    const o = i * entsize;
    const nameOffset = symData.readUInt32BE(o);
    const info = symData[o + 12];
    symbols.push({
      index: i,
      name: nameOffset < strData.length ? readCString(strData, nameOffset) : "",
      value: symData.readUInt32BE(o + 4),
      size: symData.readUInt32BE(o + 8),
      type: info & 0xf,
      bind: (info >> 4) & 0xf,
      shndx: symData.readUInt16BE(o + 14),
    });
  }
  return symbols;
}

module.exports = {
  RpxError,
  parseHeader,
  parseRpx,
  readSectionData,
  readSymbols,
  findSection,
  addrToSection,
  sectionTypeName,
  sectionFlagsHuman,
  symbolTypeName,
  symbolBindingName,
  SHF_RPL_ZLIB,
  SHT_SYMTAB,
  EM_PPC,
};
