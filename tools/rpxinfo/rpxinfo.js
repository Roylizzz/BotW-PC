#!/usr/bin/env node
"use strict";

const fs = require("fs");
const {
  RpxError,
  parseRpx,
  readSectionData,
  findSection,
  addrToSection,
  sectionTypeName,
  sectionFlagsHuman,
} = require("./lib/rpx");

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`rpxinfo — inspect Wii U RPX/RPL executables (original tool, MIT)

Usage:
  rpxinfo info <file.rpx> [--json]
  rpxinfo dump <file.rpx> <section name or index> --out <file>
  rpxinfo addr <file.rpx> <hex-address>

Notes:
  - Runs entirely locally on files you provide; never modifies them.
  - 'dump' writes the (decompressed) section bytes to --out.
    Keep dumps local; extracted data does not belong in this repository.
`);
}

function load(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    die(`cannot read ${file}: ${e.message}`);
  }
  try {
    return { buf, parsed: parseRpx(buf) };
  } catch (e) {
    die(e instanceof RpxError ? e.message : String(e));
  }
}

function hex(n, width = 8) {
  return "0x" + n.toString(16).padStart(width, "0");
}

function commandInfo(args) {
  const file = args[0];
  if (!file) die("usage: rpxinfo info <file.rpx> [--json]");
  const json = args.includes("--json");
  const { parsed } = load(file);
  const { header, sections } = parsed;

  if (json) {
    console.log(
      JSON.stringify(
        {
          header: {
            e_type: hex(header.e_type, 4),
            e_machine: header.e_machine,
            e_entry: hex(header.e_entry),
            e_shoff: header.e_shoff,
            e_shentsize: header.e_shentsize,
            e_shnum: header.e_shnum,
            e_shstrndx: header.e_shstrndx,
            e_phnum: header.e_phnum,
          },
          sections: sections.map((s) => ({
            index: s.index,
            name: s.name,
            type: sectionTypeName(s.type),
            flags: hex(s.flags),
            flagsHuman: sectionFlagsHuman(s.flags),
            addr: hex(s.addr),
            offset: s.offset,
            size: s.size,
            logicalSize: s.logicalSize,
            compressed: (s.flags & 0x08000000) !== 0,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`file     : ${file}`);
  console.log(
    `header   : ELF32 BE, machine=${header.e_machine} (PowerPC), e_type=${hex(header.e_type, 4)}, ` +
      `entry=${hex(header.e_entry)}, sections=${header.e_shnum}, phdrs=${header.e_phnum}`
  );
  console.log("");
  console.log(
    "idx  " +
      "name".padEnd(18) +
      "type".padEnd(12) +
      "flags".padEnd(26) +
      "addr".padEnd(12) +
      "offset".padEnd(12) +
      "size".padStart(12) +
      "logical".padStart(12)
  );
  for (const s of sections) {
    console.log(
      String(s.index).padStart(3) +
        "  " +
        (s.name || "").padEnd(18) +
        sectionTypeName(s.type).padEnd(12) +
        sectionFlagsHuman(s.flags).padEnd(26) +
        hex(s.addr).padEnd(12) +
        hex(s.offset).padEnd(12) +
        String(s.size).padStart(12) +
        String(s.logicalSize).padStart(12)
    );
  }
}

function commandDump(args) {
  const file = args[0];
  const selector = args[1];
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : null;
  if (!file || !selector) die("usage: rpxinfo dump <file.rpx> <section name or index> --out <file>");
  if (!out) die("missing --out <file> (dumps go to a file on purpose)");
  const { buf, parsed } = load(file);
  const section = findSection(parsed, selector);
  if (!section) die(`section '${selector}' not found (name or index)`);
  const { data, compressed } = readSectionData(buf, section);
  fs.writeFileSync(out, data);
  console.log(
    `wrote '${section.name || section.index}' -> ${out} ` +
      `(${data.length} bytes${compressed ? `, inflated from ${section.size} stored` : ""})`
  );
}

function commandAddr(args) {
  const file = args[0];
  const addrText = args[1];
  if (!file || !addrText) die("usage: rpxinfo addr <file.rpx> <hex-address>");
  if (!/^0x[0-9a-fA-F]+$/.test(addrText)) die("address must look like 0x01234567");
  const addr = parseInt(addrText, 16);
  const { parsed } = load(file);
  const section = addrToSection(parsed, addr);
  if (!section) {
    console.log(`address ${hex(addr)} is not inside any section`);
    return;
  }
  const delta = addr - section.addr;
  const compressed = (section.flags & 0x08000000) !== 0;
  console.log(`address    : ${hex(addr)}`);
  console.log(`section    : [${section.index}] ${section.name || "(unnamed)"} (${sectionTypeName(section.type)})`);
  console.log(`offset     : +${hex(delta)} from section start ${hex(section.addr)}`);
  if (!compressed) {
    console.log(`file offset: ${hex(section.offset + delta)} (section data is stored uncompressed)`);
  } else {
    console.log(`file offset: n/a — section is zlib-compressed (offset ${hex(delta)} applies after inflation)`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "help" || command === "--help" || command === "-h") {
  usage();
} else if (command === "info") {
  commandInfo(rest);
} else if (command === "dump") {
  commandDump(rest);
} else if (command === "addr") {
  commandAddr(rest);
} else {
  die(`unknown command '${command}' (try: info, dump, addr)`);
}
