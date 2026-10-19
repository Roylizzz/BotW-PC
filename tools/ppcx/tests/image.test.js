"use strict";

/**
 * Unit tests for tools/ppcx/lib/image.js against the synthetic RPX fixture.
 * Byte-level expectations are authored in the fixture, never derived from
 * the code under test.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const rpxlib = require("../../rpxinfo/lib/rpx.js");
const {
    buildImage,
    serializeImage,
    readImageBlob,
    fletcher32,
    relocationName,
    ImageError,
    IMAGE_MAGIC,
} = require("../lib/image.js");
const fixture = require("./image-fixture.js");

function parsedFixture() {
    const f = fixture.build();
    return { ...f, parsed: rpxlib.parseRpx(f.buf) };
}

test("maps every allocated section in address order and skips the rest", () => {
    const { buf, parsed, expected } = parsedFixture();
    const plan = buildImage(buf, parsed);
    assert.deepEqual(
        plan.segments.map((s) => [s.name, s.addr, s.size, s.flags & 1]),
        expected.segments.map((s) => [s.name, s.addr, s.size, s.bss ? 1 : 0])
    );
    assert.deepEqual(
        plan.segments.map((s) => ((s.flags & 2) !== 0 ? 1 : 0)),
        expected.segments.map((s) => (s.write ? 1 : 0)),
        "the writable flag comes from SHF_WRITE"
    );
    assert.equal(plan.stats.sections, expected.stats.sections);
    assert.equal(plan.stats.bytes, expected.stats.bytes);
    assert.equal(plan.stats.payloadBytes, expected.stats.payloadBytes);
    assert.equal(plan.stats.bssBytes, expected.stats.bssBytes);
});

test("applies ADDR32 relocations with addends and counts them", () => {
    const { buf, parsed, expected } = parsedFixture();
    const plan = buildImage(buf, parsed);
    const rodata = plan.segments.find((s) => s.name === ".rodata");
    const data = plan.segments.find((s) => s.name === ".data");
    assert.ok(rodata.data.equals(expected.rodataAfterRelocs), "rodata bytes after relocation");
    assert.ok(data.data.equals(expected.dataAfterRelocs), "data bytes after relocation");
    assert.deepEqual(plan.relocations.applied, expected.applied);
});

test("leaves executable-site relocations to the recompiler", () => {
    const { buf, parsed, expected } = parsedFixture();
    const plan = buildImage(buf, parsed);
    const text = plan.segments.find((s) => s.name === ".text");
    assert.ok(text.data.equals(expected.textPayload), ".text bytes are untouched");
    assert.equal(plan.relocations.code, expected.codeRelocations);
    assert.ok(plan.notes.some((n) => /executable sections belong to the recompiler/.test(n)));
});

test("defers TLS relocations, naming site and symbol", () => {
    const { buf, parsed, expected } = parsedFixture();
    const plan = buildImage(buf, parsed);
    assert.deepEqual(
        plan.relocations.deferred.map((d) => [d.addr, d.type, d.symbol]),
        expected.deferred.map((d) => [d.addr, d.type, "tls_value"])
    );
    const rodata = plan.segments.find((s) => s.name === ".rodata");
    assert.equal(rodata.data.readUInt32BE(8), expected.rodataAfterRelocs.readUInt32BE(8));
    assert.equal(rodata.data.readUInt32BE(12), expected.rodataAfterRelocs.readUInt32BE(12));
    assert.ok(plan.notes.some((n) => /TLS relocation site\(s\) are deferred/.test(n)));
});

test("notes uninterpreted section flags instead of dropping them", () => {
    const { buf, parsed } = parsedFixture();
    const plan = buildImage(buf, parsed);
    assert.ok(plan.notes.some((n) => /\.bss carries uninterpreted section flag\(s\) 0x4000000/.test(n)));
});

test("rejects an unsupported relocation type, naming the site", () => {
    const { buf, layout, parsed: _ } = fixture.build();
    fixture.patchRela(buf, layout.relaEntry(".rela.rodata", 0), { offset: 0x00020000, type: 10, sym: 1, addend: 0 });
    const parsed = rpxlib.parseRpx(buf);
    assert.throws(
        () => buildImage(buf, parsed),
        (e) => e instanceof ImageError && e.issues.some((i) => /R_PPC_10 at 0x00020000 in \.rodata is not supported/.test(i))
    );
});

test("rejects a relocation outside every section", () => {
    const { buf, layout } = fixture.build();
    fixture.patchRela(buf, layout.relaEntry(".rela.rodata", 0), { offset: 0x0bad0000, type: 1, sym: 1, addend: 0 });
    const parsed = rpxlib.parseRpx(buf);
    assert.throws(
        () => buildImage(buf, parsed),
        (e) => e instanceof ImageError && e.issues.some((i) => /R_PPC_ADDR32 at 0x0bad0000 is not inside any section/.test(i))
    );
});

test("rejects a relocation into BSS", () => {
    const { buf, layout } = fixture.build();
    fixture.patchRela(buf, layout.relaEntry(".rela.rodata", 0), { offset: 0x00020204, type: 1, sym: 1, addend: 0 });
    const parsed = rpxlib.parseRpx(buf);
    assert.throws(
        () => buildImage(buf, parsed),
        (e) => e instanceof ImageError && e.issues.some((i) => /falls in BSS \(\.bss\)/.test(i))
    );
});

test("rejects overlapping sections", () => {
    const { buf, layout } = fixture.build();
    fixture.patchSectionAddr(buf, layout, ".data", 0x00020008);
    const parsed = rpxlib.parseRpx(buf);
    assert.throws(
        () => buildImage(buf, parsed),
        (e) => e instanceof ImageError && e.issues.some((i) => /\.data at 0x00020008 overlaps the previous segment/.test(i))
    );
});

test("rejects sections outside the guest arena", () => {
    const { buf, layout } = fixture.build();
    fixture.patchSectionAddr(buf, layout, ".data", 0xc2000000);
    const parsed = rpxlib.parseRpx(buf);
    assert.throws(
        () => buildImage(buf, parsed),
        (e) => e instanceof ImageError && e.issues.some((i) => /\.data \(0xc2000000\+8\) leaves the guest arena/.test(i))
    );
});

test("serializes and re-reads the blob", () => {
    const { buf, parsed, expected } = parsedFixture();
    const plan = buildImage(buf, parsed);
    const blob = serializeImage(plan);
    assert.ok(blob.subarray(0, 8).equals(IMAGE_MAGIC));
    assert.equal(blob.readUInt32BE(8), expected.stats.sections);

    const read = readImageBlob(blob);
    assert.equal(read.count, expected.stats.sections);
    assert.deepEqual(
        read.segments.map((s) => [s.addr, s.size, s.flags & 1, (s.flags & 2) !== 0 ? 1 : 0]),
        expected.segments.map((s) => [s.addr, s.size, s.bss ? 1 : 0, s.write ? 1 : 0])
    );
    assert.equal(blob.readUInt32BE(12), fletcher32(blob.subarray(read.tableEnd)));

    /* The first payload belongs to .text, the second to .rodata. */
    const rodata = read.segments[1];
    assert.ok(
        blob.subarray(rodata.payloadOffset, rodata.payloadOffset + rodata.size).equals(expected.rodataAfterRelocs),
        "serialized .rodata payload matches the relocated bytes"
    );
});

test("serializeImage refuses overlapping or unsorted segments", () => {
    const { buf, parsed } = parsedFixture();
    const plan = buildImage(buf, parsed);
    const swapped = [...plan.segments].reverse();
    assert.throws(() => serializeImage({ segments: swapped }), /overlaps the previous segment/);
});

test("rejects a corrupted blob before it can be mapped", () => {
    const { buf, parsed } = parsedFixture();
    const blob = serializeImage(buildImage(buf, parsed));

    const flipped = Buffer.from(blob);
    flipped[flipped.length - 1] ^= 0x40;
    assert.throws(() => readImageBlob(flipped), /checksum mismatch/);

    const badMagic = Buffer.from(blob);
    badMagic[0] = 0x00;
    assert.throws(() => readImageBlob(badMagic), /magic/);

    const truncated = blob.subarray(0, blob.length - 8);
    assert.throws(() => readImageBlob(truncated), /runs past the end/);

    const zeroCount = Buffer.from(blob);
    zeroCount.writeUInt32BE(0, 8);
    assert.throws(() => readImageBlob(zeroCount), /bad segment count/);

    const badFlags = Buffer.from(blob);
    badFlags.writeUInt32BE(0x4, 16 + 12);
    assert.throws(() => readImageBlob(badFlags), /unknown flags 0x4/);
});

test("serializeImage rejects unknown segment flags", () => {
    const { buf, parsed } = parsedFixture();
    const plan = buildImage(buf, parsed);
    const segments = plan.segments.map((s, i) => (i === 0 ? { ...s, flags: s.flags | 0x4 } : s));
    assert.throws(() => serializeImage({ segments }), /unknown flags 0x/);
});

test("relocationName falls back to the raw number", () => {
    assert.equal(relocationName(1), "R_PPC_ADDR32");
    assert.equal(relocationName(10), "R_PPC_10");
});
