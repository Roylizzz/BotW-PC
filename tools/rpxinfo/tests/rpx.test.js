"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  parseRpx,
  readSectionData,
  findSection,
  addrToSection,
  sectionFlagsHuman,
  SHF_RPL_ZLIB,
} = require("../lib/rpx.js");
const { build } = require("./fixture.js");

test("parses the synthetic header", () => {
  const { buffer } = build();
  const { header } = parseRpx(buffer);
  assert.equal(header.e_machine, 20);
  assert.equal(header.e_type, 0xfe01);
  assert.equal(header.e_shnum, 4);
  assert.equal(header.e_shstrndx, 3);
  assert.equal(header.e_phnum, 0);
  assert.equal(header.e_entry, 0x02000024);
});

test("reads section names from the string table", () => {
  const { buffer, expected } = build();
  const { sections } = parseRpx(buffer);
  assert.deepEqual(
    sections.map((s) => s.name),
    expected.names
  );
});

test("keeps plain sections intact and inflates zlib sections", () => {
  const { buffer, expected } = build();
  const parsed = parseRpx(buffer);

  const stub = findSection(parsed, ".stub");
  const stubData = readSectionData(buffer, stub);
  assert.equal(stubData.compressed, false);
  assert.ok(stubData.data.equals(expected.stub));

  const textz = findSection(parsed, ".textz");
  assert.ok(textz.flags & SHF_RPL_ZLIB);
  const textData = readSectionData(buffer, textz);
  assert.equal(textData.compressed, true);
  assert.ok(textData.data.equals(expected.textPayload));
  assert.equal(textData.declaredSize, expected.textPayload.length);
});

test("address mapping uses logical (decompressed) sizes", () => {
  const { buffer } = build();
  const parsed = parseRpx(buffer);
  assert.equal(addrToSection(parsed, 0x02000004).name, ".stub");
  assert.equal(addrToSection(parsed, 0x02000024).name, ".textz");
  assert.equal(addrToSection(parsed, 0x02009000), null);
});

test("findSection accepts index, name and bare name", () => {
  const { buffer } = build();
  const parsed = parseRpx(buffer);
  assert.equal(findSection(parsed, "2").name, ".textz");
  assert.equal(findSection(parsed, ".textz").index, 2);
  assert.equal(findSection(parsed, "textz").index, 2);
  assert.equal(findSection(parsed, "nope"), null);
});

test("human flags decode RPL_ZLIB", () => {
  assert.equal(sectionFlagsHuman(0x08000006), "ALLOC|EXEC|RPL_ZLIB");
  assert.equal(sectionFlagsHuman(0), "-");
});

test("CLI info prints a section table", () => {
  const { buffer } = build();
  const tmp = path.join(os.tmpdir(), `rpxinfo-test-${process.pid}.rpx`);
  fs.writeFileSync(tmp, buffer);
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(__dirname, "..", "rpxinfo.js"), "info", tmp],
      { encoding: "utf8" }
    );
    assert.match(out, /\.textz/);
    assert.match(out, /RPL_ZLIB/);
    assert.match(out, /PowerPC/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("CLI dump writes the inflated section", () => {
  const { buffer, expected } = build();
  const tmp = path.join(os.tmpdir(), `rpxinfo-test-${process.pid}.rpx`);
  const outFile = path.join(os.tmpdir(), `rpxinfo-test-out-${process.pid}.bin`);
  fs.writeFileSync(tmp, buffer);
  try {
    execFileSync(
      process.execPath,
      [path.join(__dirname, "..", "rpxinfo.js"), "dump", tmp, ".textz", "--out", outFile],
      { encoding: "utf8" }
    );
    assert.ok(fs.readFileSync(outFile).equals(expected.textPayload));
  } finally {
    fs.unlinkSync(tmp);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }
});
