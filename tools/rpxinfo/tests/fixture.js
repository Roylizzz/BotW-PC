"use strict";

/**
 * Synthetic RPX fixture builder for tests.
 *
 * Every byte of this fixture is authored here; no data from any game is
 * used. The fixture mimics the structural traits we care about: ELF32 BE
 * header, custom RPX e_type, no program headers, a plain section, a
 * zlib-compressed section with a 4-byte size prefix, a string table, and
 * a symbol table.
 */

const zlib = require("zlib");

function writeU32(buf, offset, value) {
  buf.writeUInt32BE(value >>> 0, offset);
}

function writeU16(buf, offset, value) {
  buf.writeUInt16BE(value & 0xffff, offset);
}

function build() {
  // Authored PowerPC bytes: "li r3, 42" ; "blr"
  const stub = Buffer.from([0x38, 0x60, 0x00, 0x2a, 0x4e, 0x80, 0x00, 0x20]);

  // Authored payload with a deterministic pattern.
  const textPayload = Buffer.alloc(64);
  for (let i = 0; i < textPayload.length; i++) textPayload[i] = (i * 7 + 3) & 0xff;

  const deflated = zlib.deflateSync(textPayload, { level: 9 });
  const textz = Buffer.concat([Buffer.from([0, 0, 0, 0]), deflated]);
  writeU32(textz, 0, textPayload.length);

  const shstr = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(".stub", "utf8"),
    Buffer.from([0]),
    Buffer.from(".textz", "utf8"),
    Buffer.from([0]),
    Buffer.from(".shstrtab", "utf8"),
    Buffer.from([0]),
    Buffer.from(".symtab", "utf8"),
    Buffer.from([0]),
    Buffer.from(".strtab", "utf8"),
    Buffer.from([0]),
    Buffer.from(".rela.text", "utf8"),
    Buffer.from([0]),
  ]);
  const shNameOff = { stub: 1, textz: 7, shstrtab: 14, symtab: 24, strtab: 32, relaText: 40 };

  const symstr = Buffer.concat([
    Buffer.from([0]),
    Buffer.from("imported_func", "utf8"),
    Buffer.from([0]),
    Buffer.from("data_global", "utf8"),
    Buffer.from([0]),
    Buffer.from("local_label", "utf8"),
    Buffer.from([0]),
  ]);
  const symNameOff = { imported: 1, data: 15, local: 27 };

  const symtab = Buffer.alloc(4 * 16);
  let o = 16; // entry 0 is the null symbol (zeroed)
  writeU32(symtab, o, symNameOff.imported);
  writeU32(symtab, o + 4, 0xc0000000);
  writeU32(symtab, o + 8, 0);
  symtab[o + 12] = (1 << 4) | 2; // GLOBAL FUNC
  writeU16(symtab, o + 14, 11);
  o = 32;
  writeU32(symtab, o, symNameOff.data);
  writeU32(symtab, o + 4, 0x10000000);
  writeU32(symtab, o + 8, 4);
  symtab[o + 12] = (1 << 4) | 1; // GLOBAL OBJECT
  writeU16(symtab, o + 14, 3);
  o = 48;
  writeU32(symtab, o, symNameOff.local);
  writeU32(symtab, o + 4, 0x02000020);
  writeU32(symtab, o + 8, 0);
  symtab[o + 12] = (0 << 4) | 0; // LOCAL NOTYPE
  writeU16(symtab, o + 14, 2);

  const headerSize = 64;
  const sectionCount = 7;
  // The section-header array spans [64, 64 + 7*40 = 344); all section
  // data must start after it to avoid clobbering header fields.
  const stubOffset = 0x200;
  const textzOffset = 0x300;
  const shstrOffset = 0x500;
  const symtabOffset = 0x600;
  const strtabOffset = 0x700;
  const relaOffset = 0x800;
  const relas = Buffer.alloc(2 * 12);
  writeU32(relas, 0, 0x02000024);
  writeU32(relas, 4, (1 << 8) | 10); // symbol 1, R_PPC_REL24
  writeU32(relas, 8, 0);
  writeU32(relas, 12, 0x02000028);
  writeU32(relas, 16, (2 << 8) | 6); // symbol 2, R_PPC_ADDR16_HA
  writeU32(relas, 20, 4);
  const totalSize = relaOffset + relas.length + 0x40;
  const buf = Buffer.alloc(totalSize);

  // --- ELF header ---
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 1; // 32-bit
  buf[5] = 2; // big-endian
  buf[6] = 1; // EV_CURRENT
  buf[7] = 0xca; // Wii U OSABI convention
  buf[8] = 0xfe;
  writeU16(buf, 16, 0xfe01); // RPX custom e_type
  writeU16(buf, 18, 20); // EM_PPC
  writeU32(buf, 20, 1); // e_version
  writeU32(buf, 24, 0x02000024); // e_entry (inside .textz)
  writeU32(buf, 28, 0); // e_phoff
  writeU32(buf, 32, headerSize); // e_shoff
  writeU32(buf, 36, 0); // e_flags
  writeU16(buf, 40, 52); // e_ehsize
  writeU16(buf, 42, 0); // e_phentsize
  writeU16(buf, 44, 0); // e_phnum
  writeU16(buf, 46, 40); // e_shentsize
  writeU16(buf, 48, sectionCount); // e_shnum
  writeU16(buf, 50, 3); // e_shstrndx

  const sec = (i) => headerSize + i * 40;

  // section 0: null (already zeroed)
  // section 1: .stub — PROGBITS, ALLOC|EXEC
  writeU32(buf, sec(1), shNameOff.stub);
  writeU32(buf, sec(1) + 4, 1);
  writeU32(buf, sec(1) + 8, 0x6);
  writeU32(buf, sec(1) + 12, 0x02000000);
  writeU32(buf, sec(1) + 16, stubOffset);
  writeU32(buf, sec(1) + 20, stub.length);
  writeU32(buf, sec(1) + 32, 4);

  // section 2: .textz — PROGBITS, ALLOC|EXEC|RPL_ZLIB
  writeU32(buf, sec(2), shNameOff.textz);
  writeU32(buf, sec(2) + 4, 1);
  writeU32(buf, sec(2) + 8, 0x08000006);
  writeU32(buf, sec(2) + 12, 0x02000020);
  writeU32(buf, sec(2) + 16, textzOffset);
  writeU32(buf, sec(2) + 20, textz.length);
  writeU32(buf, sec(2) + 32, 4);

  // section 3: .shstrtab — STRTAB
  writeU32(buf, sec(3), shNameOff.shstrtab);
  writeU32(buf, sec(3) + 4, 3);
  writeU32(buf, sec(3) + 16, shstrOffset);
  writeU32(buf, sec(3) + 20, shstr.length);
  writeU32(buf, sec(3) + 32, 1);

  // section 4: .symtab — SYMTAB, sh_link -> .strtab (index 5)
  writeU32(buf, sec(4), shNameOff.symtab);
  writeU32(buf, sec(4) + 4, 2);
  writeU32(buf, sec(4) + 16, symtabOffset);
  writeU32(buf, sec(4) + 20, symtab.length);
  writeU32(buf, sec(4) + 24, 5);
  writeU32(buf, sec(4) + 28, 1);
  writeU32(buf, sec(4) + 32, 4);
  writeU32(buf, sec(4) + 36, 16);

  // section 5: .strtab — STRTAB
  writeU32(buf, sec(5), shNameOff.strtab);
  writeU32(buf, sec(5) + 4, 3);
  writeU32(buf, sec(5) + 16, strtabOffset);
  writeU32(buf, sec(5) + 20, symstr.length);
  writeU32(buf, sec(5) + 32, 1);

  // section 6: .rela.text — RELA, link -> .symtab (index 4), info -> .textz (index 2)
  writeU32(buf, sec(6), shNameOff.relaText);
  writeU32(buf, sec(6) + 4, 4);
  writeU32(buf, sec(6) + 16, relaOffset);
  writeU32(buf, sec(6) + 20, relas.length);
  writeU32(buf, sec(6) + 24, 4);
  writeU32(buf, sec(6) + 28, 2);
  writeU32(buf, sec(6) + 32, 4);
  writeU32(buf, sec(6) + 36, 12);

  stub.copy(buf, stubOffset);
  textz.copy(buf, textzOffset);
  shstr.copy(buf, shstrOffset);
  symtab.copy(buf, symtabOffset);
  symstr.copy(buf, strtabOffset);
  relas.copy(buf, relaOffset);

  return {
    buffer: buf,
    expected: {
      stub,
      textPayload,
      deflated,
      names: ["", ".stub", ".textz", ".shstrtab", ".symtab", ".strtab", ".rela.text"],
      symbols: [
        { name: "", value: 0, size: 0, type: 0, bind: 0, shndx: 0 },
        { name: "imported_func", value: 0xc0000000, size: 0, type: 2, bind: 1, shndx: 11 },
        { name: "data_global", value: 0x10000000, size: 4, type: 1, bind: 1, shndx: 3 },
        { name: "local_label", value: 0x02000020, size: 0, type: 0, bind: 0, shndx: 2 },
      ],
      relocs: [
        { offset: 0x02000024, type: 10, sym: 1, addend: 0 },
        { offset: 0x02000028, type: 6, sym: 2, addend: 4 },
      ],
    },
  };
}

module.exports = { build };
