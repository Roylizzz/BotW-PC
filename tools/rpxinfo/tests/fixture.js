"use strict";

/**
 * Synthetic RPX fixture builder for tests.
 *
 * Every byte of this fixture is authored here; no data from any game is
 * used. The fixture mimics the structural traits we care about: ELF32 BE
 * header, custom RPX e_type, no program headers, a plain section, a
 * zlib-compressed section with a 4-byte size prefix, and a string table.
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

  const strtab = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(".stub", "utf8"),
    Buffer.from([0]),
    Buffer.from(".textz", "utf8"),
    Buffer.from([0]),
    Buffer.from(".shstrtab", "utf8"),
    Buffer.from([0]),
  ]);
  const nameOff = { stub: 1, textz: 7, shstrtab: 14 };

  const headerSize = 64;
  const sectionCount = 4;
  const sectionTableSize = sectionCount * 40;
  const stubOffset = 0x100;
  const textzOffset = 0x200;
  const strtabOffset = 0x400;
  const totalSize = strtabOffset + strtab.length + 0x40;
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
  writeU32(buf, sec(1), nameOff.stub);
  writeU32(buf, sec(1) + 4, 1);
  writeU32(buf, sec(1) + 8, 0x6);
  writeU32(buf, sec(1) + 12, 0x02000000);
  writeU32(buf, sec(1) + 16, stubOffset);
  writeU32(buf, sec(1) + 20, stub.length);
  writeU32(buf, sec(1) + 32, 4);

  // section 2: .textz — PROGBITS, ALLOC|EXEC|RPL_ZLIB
  writeU32(buf, sec(2), nameOff.textz);
  writeU32(buf, sec(2) + 4, 1);
  writeU32(buf, sec(2) + 8, 0x08000006);
  writeU32(buf, sec(2) + 12, 0x02000020);
  writeU32(buf, sec(2) + 16, textzOffset);
  writeU32(buf, sec(2) + 20, textz.length);
  writeU32(buf, sec(2) + 32, 4);

  // section 3: .shstrtab — STRTAB
  writeU32(buf, sec(3), nameOff.shstrtab);
  writeU32(buf, sec(3) + 4, 3);
  writeU32(buf, sec(3) + 16, strtabOffset);
  writeU32(buf, sec(3) + 20, strtab.length);
  writeU32(buf, sec(3) + 32, 1);

  stub.copy(buf, stubOffset);
  textz.copy(buf, textzOffset);
  strtab.copy(buf, strtabOffset);

  return { buffer: buf, expected: { stub, textPayload, deflated, names: ["", ".stub", ".textz", ".shstrtab"] } };
}

module.exports = { build };
