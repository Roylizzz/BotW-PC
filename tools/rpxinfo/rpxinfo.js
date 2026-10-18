#!/usr/bin/env node
"use strict";

const fs = require("fs");
const {
  RpxError,
  parseRpx,
  readSectionData,
  readSymbols,
  readRelocations,
  findSection,
  addrToSection,
  sectionTypeName,
  sectionFlagsHuman,
  symbolTypeName,
  symbolBindingName,
} = require("./lib/rpx");

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`rpxinfo — inspect Wii U RPX/RPL executables (original tool, MIT)

Usage:
  rpxinfo info    <file.rpx> [--json]
  rpxinfo symbols <file.rpx> [--json] [--func] [--defined] [--limit N]
  rpxinfo relocs  <file.rpx> [--section .rela.text] [--json] [--out relocs.csv] [--limit N]
  rpxinfo dump    <file.rpx> <section name or index> --out <file>
  rpxinfo addr    <file.rpx> <hex-address>

Notes:
  - Runs entirely locally on files you provide; never modifies them.
  - 'symbols' reads the .symtab table (standard 16-byte Elf32_Sym layout).
  - 'relocs' reads a relocation section (12-byte Elf32_Rela) and prints a
    per-symbol count; --out writes every entry as CSV for local analysis.
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

function commandSymbols(args) {
  const file = args[0];
  if (!file) die("usage: rpxinfo symbols <file.rpx> [--json] [--func] [--defined] [--limit N]");
  const json = args.includes("--json");
  const onlyFunc = args.includes("--func");
  const onlyDefined = args.includes("--defined");
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) : Infinity;
  if (limitIndex >= 0 && !Number.isFinite(limit)) die("--limit needs a number");

  const { buf, parsed } = load(file);
  const all = readSymbols(buf, parsed);
  if (all.length === 0) die("no symbol table (.symtab) found");

  let symbols = all;
  if (onlyFunc) symbols = symbols.filter((s) => s.type === 2);
  if (onlyDefined) symbols = symbols.filter((s) => s.shndx !== 0);

  const shown = symbols.slice(0, Number.isFinite(limit) ? limit : symbols.length);

  if (json) {
    console.log(
      JSON.stringify(
        shown.map((s) => ({
          index: s.index,
          name: s.name,
          value: hex(s.value),
          size: s.size,
          type: symbolTypeName(s.type),
          bind: symbolBindingName(s.bind),
          shndx: s.shndx,
        })),
        null,
        2
      )
    );
    return;
  }

  const filterNote = symbols.length !== all.length ? ` (of ${all.length} total)` : "";
  if (shown.length !== symbols.length) {
    console.log(`symbols: showing ${shown.length} of ${symbols.length}${filterNote}`);
  } else {
    console.log(`symbols: ${shown.length}${filterNote}`);
  }
  for (const s of shown) {
    console.log(
      String(s.index).padStart(5) +
        " " +
        symbolBindingName(s.bind).padEnd(7) +
        symbolTypeName(s.type).padEnd(8) +
        ("shndx=" + s.shndx).padEnd(9) +
        hex(s.value) +
        "  size=" +
        String(s.size).padStart(7) +
        "  " +
        s.name
    );
  }
}

function commandRelocs(args) {
  const file = args[0];
  if (!file) {
    die("usage: rpxinfo relocs <file.rpx> [--section .rela.text] [--json] [--out relocs.csv] [--limit N]");
  }
  const json = args.includes("--json");
  const secIndex = args.indexOf("--section");
  const selector = secIndex >= 0 ? args[secIndex + 1] : ".rela.text";
  if (secIndex >= 0 && !selector) die("--section needs a name or index");
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : null;
  if (outIndex >= 0 && !out) die("--out needs a file");
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) : 30;
  if (limitIndex >= 0 && !Number.isFinite(limit)) die("--limit needs a number");

  const { buf, parsed } = load(file);
  const result = readRelocations(buf, parsed, selector);
  if (!result) die(`no relocation section '${selector}' found`);
  const { section, relocations } = result;
  const symbols = readSymbols(buf, parsed);
  const nameOf = (index) => (symbols[index] && symbols[index].name) || `sym${index}`;

  if (out) {
    const lines = ["symbol,type,offset,addend"];
    for (const r of relocations) {
      lines.push(`${nameOf(r.sym)},${r.type},${hex(r.offset)},${r.addend}`);
    }
    fs.writeFileSync(out, lines.join("\n") + "\n");
    console.log(`wrote ${relocations.length} relocations from '${section.name || section.index}' -> ${out}`);
    return;
  }

  const counts = new Map();
  for (const r of relocations) {
    const name = nameOf(r.sym);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  if (json) {
    console.log(
      JSON.stringify(
        {
          section: section.name || String(section.index),
          total: relocations.length,
          symbols: sorted.map(([name, count]) => ({ name, count })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `relocations: ${relocations.length} in '${section.name || section.index}' (${sorted.length} distinct symbols)`
  );
  for (const [name, count] of sorted.slice(0, Number.isFinite(limit) ? limit : sorted.length)) {
    console.log(String(count).padStart(7) + "  " + name);
  }
  if (sorted.length > limit) console.log(`... ${sorted.length - limit} more symbols`);
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
} else if (command === "symbols") {
  commandSymbols(rest);
} else if (command === "relocs") {
  commandRelocs(rest);
} else if (command === "dump") {
  commandDump(rest);
} else if (command === "addr") {
  commandAddr(rest);
} else {
  die(`unknown command '${command}' (try: info, symbols, relocs, dump, addr)`);
}
