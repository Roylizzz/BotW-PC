"use strict";

/**
 * Load-image builder for RPX modules.
 *
 * The console loader maps every allocated section of an RPL into the guest
 * address space, applies the dynamic relocations and zero-fills the NOBITS
 * sections before the first instruction runs. Translated code needs the same
 * picture: it reads globals, strings and dispatch tables from those bytes, so
 * an empty arena is not a valid runtime state.
 *
 * `buildImage` validates the allocated sections, materializes their payloads
 * (decompressing zlib sections, zero-filling NOBITS), applies the data
 * relocations and describes the result as a load plan. `serializeImage` turns
 * the plan into the self-describing PPCXIMG1 blob the C loader
 * (`src/runtime/src/ppcx_image.c`) maps into its arena.
 *
 * Relocation policy (explicit, never silent):
 *   - R_PPC_NONE is skipped but counted;
 *   - R_PPC_ADDR32 (S + A) is written into the mapped bytes;
 *   - sites inside executable sections are the recompiler's business
 *     (REL24/ADDR16*): counted, left untouched, because code is translated
 *     from the file bytes, not relocated in memory;
 *   - R_PPC_DTPMOD32 writes the deterministic main-module id and
 *     R_PPC_DTPREL32 writes the symbol-relative TLS offset (S + A). The
 *     measured v208 TLSIndex objects already carry plain 0/4/8 offsets, so
 *     the model uses base + offset and does not add the generic PowerPC
 *     -0x8000 DTP bias. The HLE TLS block is documented in
 *     src/runtime/include/ppcx_hle.h;
 *   - any other type is a build error that names every offending site.
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

const rpxlib = require("../../rpxinfo/lib/rpx.js");

/* PPCXIMG1 layout (all integers big-endian):
 *   offset 0   magic "PPCXIMG1" (8 bytes)
 *   offset 8   segment count (1..PPCX_IMAGE_MAX_SEGMENTS)
 *   offset 12  Fletcher-32 of the payload region (bytes after the table)
 *   offset 16  segment table, 16 bytes per entry:
 *                addr, size, payload offset (0 for BSS), flags
 *                (bit 0 = BSS, bit 1 = writable; other bits are rejected)
 *   then       payloads in entry order, no padding
 */
const IMAGE_MAGIC = Buffer.from("PPCXIMG1", "ascii");
const IMAGE_HEADER_SIZE = 16;
const IMAGE_ENTRY_SIZE = 16;
const IMAGE_MAX_SEGMENTS = 1024;
const IMAGE_FLAG_BSS = 0x1;
const IMAGE_FLAG_WRITE = 0x2;
const IMAGE_FLAG_KNOWN = IMAGE_FLAG_BSS | IMAGE_FLAG_WRITE;

/* Mirrors PPCX_ARENA_BYTES in src/runtime/include/ppcx_abi.h. */
const ARENA_BYTES = 0xc2000000;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHF_RPL_ZLIB = 0x08000000;
const SHF_KNOWN = SHF_WRITE | SHF_ALLOC | SHF_EXECINSTR | SHF_RPL_ZLIB;

const SHT_RELA = 0x4;
const SHT_NOBITS = 0x8;

const R_PPC_NONE = 0;
const R_PPC_ADDR32 = 1;
const R_PPC_DTPMOD32 = 68;
const R_PPC_DTPREL32 = 78;

/* Mirrors PPCX_TLS_MODULE_ID and PPCX_TLS_DATA_SIZE in
 * src/runtime/include/ppcx_hle.h. The image must fail early if a TLS symbol
 * would not fit the runtime's deterministic block. */
const TLS_MODULE_ID = 1;
const TLS_BLOCK_BYTES = 0xf00;
const STT_TLS = 6;

const RELOCATION_NAMES = new Map([
    [R_PPC_NONE, "R_PPC_NONE"],
    [R_PPC_ADDR32, "R_PPC_ADDR32"],
    [R_PPC_DTPMOD32, "R_PPC_DTPMOD32"],
    [R_PPC_DTPREL32, "R_PPC_DTPREL32"],
]);

function relocationName(type) {
    return RELOCATION_NAMES.get(type) || `R_PPC_${type}`;
}

function hex8(v) {
    return (v >>> 0).toString(16).padStart(8, "0");
}

class ImageError extends Error {
    constructor(issues) {
        const list = Array.isArray(issues) ? issues : [issues];
        super(list.length > 1 ? `${list[0]} (and ${list.length - 1} more)` : list[0]);
        this.name = "ImageError";
        this.issues = list;
    }
}

/*
 * Fletcher-32 with the usual periodic reduction (359-byte blocks keep the
 * 32-bit accumulators from overflowing). The C loader runs the identical
 * algorithm; the compiled loader tests compare both implementations.
 */
function fletcher32(buf) {
    let a = 0xffff;
    let b = 0xffff;
    let i = 0;
    while (i < buf.length) {
        const n = Math.min(359, buf.length - i);
        for (let k = 0; k < n; k++, i++) {
            a += buf[i];
            b += a;
        }
        a = (a & 0xffff) + (a >>> 16);
        b = (b & 0xffff) + (b >>> 16);
    }
    a = (a & 0xffff) + (a >>> 16);
    b = (b & 0xffff) + (b >>> 16);
    a = (a & 0xffff) + (a >>> 16);
    b = (b & 0xffff) + (b >>> 16);
    return ((b << 16) | a) >>> 0;
}

/**
 * Builds the load plan of an RPX: one segment per allocated section (address
 * order) with the data relocations already applied.
 *
 * @param {Buffer} buf raw RPX bytes
 * @param {object} parsed result of rpxinfo's parseRpx
 * @returns {{segments, relocations, notes, stats}}
 */
function buildImage(buf, parsed) {
    const issues = [];
    const notes = [];
    const sections = parsed.sections;
    const symbols = rpxlib.readSymbols(buf, parsed);

    /* --- segments ---------------------------------------------------- */
    const segments = [];
    const emptySections = [];
    for (const s of sections) {
        if (s.index === 0 || (s.flags & SHF_ALLOC) === 0) continue;
        if (s.logicalSize === 0) {
            emptySections.push(s);
            continue;
        }
        const bss = s.type === SHT_NOBITS;
        let data = null;
        if (!bss) {
            const read = rpxlib.readSectionData(buf, s);
            data = read.data;
            if (data.length !== s.logicalSize) {
                issues.push(
                    `section ${s.index} ${s.name || "(noname)"}: payload is ${data.length} bytes but the ` +
                        `declared logical size is ${s.logicalSize}`
                );
            }
        }
        segments.push({
            index: s.index,
            name: s.name || `section-${s.index}`,
            addr: s.addr >>> 0,
            size: s.logicalSize >>> 0,
            flags: (bss ? IMAGE_FLAG_BSS : 0) | ((s.flags & SHF_WRITE) !== 0 ? IMAGE_FLAG_WRITE : 0),
            data,
            elfFlags: s.flags >>> 0,
        });
    }
    if (emptySections.length > 0) {
        notes.push(
            `${emptySections.length} allocated section(s) with size 0 are not mapped: ` +
                emptySections.map((s) => s.name || s.index).join(", ")
        );
    }

    segments.sort((a, b) => a.addr - b.addr);
    let prevEnd = 0;
    for (const seg of segments) {
        if (seg.addr + seg.size > ARENA_BYTES) {
            issues.push(
                `segment ${seg.name} (0x${hex8(seg.addr)}+${seg.size}) leaves the guest arena ` +
                    `(0x${hex8(ARENA_BYTES)} bytes)`
            );
        }
        if (seg.addr < prevEnd) {
            issues.push(
                `segment ${seg.name} at 0x${hex8(seg.addr)} overlaps the previous segment ending at 0x${hex8(prevEnd)}`
            );
        }
        prevEnd = Math.max(prevEnd, seg.addr + seg.size);
        const extra = seg.elfFlags & ~SHF_KNOWN;
        if (extra) {
            notes.push(
                `section ${seg.index} ${seg.name} carries uninterpreted section flag(s) ` +
                    `0x${(extra >>> 0).toString(16)}; mapped as a plain ${seg.flags & IMAGE_FLAG_BSS ? "zero-filled BSS" : "data"} segment`
            );
        }
    }

    /* --- relocations -------------------------------------------------- */
    const segmentByIndex = new Map(segments.map((seg) => [seg.index, seg]));
    const appliedCounts = new Map();
    const tlsSites = [];
    const tlsSymbols = new Map();
    let codeSites = 0;
    let noneSites = 0;

    const recordTlsSymbol = (sym, offset) => {
        tlsSymbols.set(sym.name, {
            name: sym.name,
            offset: offset >>> 0,
            size: sym.size >>> 0,
        });
    };

    const tlsSymbolIssue = (site, sym) => {
        if (sym.type !== STT_TLS) {
            return `${site} references non-TLS symbol ${sym.name || "(unnamed)"} ` +
                `(type ${sym.type}); TLS relocations require STT_TLS`;
        }
        const section = sections.find((s) => s.index === sym.shndx);
        if (!section || section.type !== SHT_NOBITS) {
            return `${site} references ${sym.name || "(unnamed)"} in initialized storage; ` +
                `only zero-filled thread BSS is modeled for TLS`;
        }
        return null;
    };

    for (const relaSection of sections) {
        if (relaSection.type !== SHT_RELA) continue;
        const reloc = rpxlib.readRelocations(buf, parsed, String(relaSection.index));
        if (!reloc) continue;
        for (const rel of reloc.relocations) {
            const addr = rel.offset >>> 0;
            const target = rpxlib.addrToSection(parsed, addr);
            const site = `${relocationName(rel.type)} at 0x${hex8(addr)}`;
            if (!target) {
                issues.push(`${site} is not inside any section`);
                continue;
            }
            const seg = segmentByIndex.get(target.index);
            if (!seg) {
                issues.push(`${site} falls in ${target.name || `section ${target.index}`}, which is not mapped`);
                continue;
            }
            if (target.flags & SHF_EXECINSTR) {
                codeSites++;
                continue;
            }
            if (seg.flags & IMAGE_FLAG_BSS) {
                issues.push(`${site} falls in BSS (${seg.name})`);
                continue;
            }
            const offset = addr - seg.addr;
            if (offset + 4 > seg.size) {
                issues.push(`${site} does not fit in ${seg.name}`);
                continue;
            }
            const sym = symbols[rel.sym];
            if (!sym) {
                issues.push(`${site} references symbol ${rel.sym}, which is not in .symtab`);
                continue;
            }
            switch (rel.type) {
                case R_PPC_NONE:
                    noneSites++;
                    break;
                case R_PPC_ADDR32: {
                    const value = ((sym.value >>> 0) + (rel.addend >>> 0)) >>> 0;
                    seg.data.writeUInt32BE(value, offset);
                    appliedCounts.set(rel.type, (appliedCounts.get(rel.type) || 0) + 1);
                    break;
                }
                case R_PPC_DTPMOD32: {
                    const problem = tlsSymbolIssue(site, sym);
                    if (problem) {
                        issues.push(problem);
                        break;
                    }
                    if ((sym.value >>> 0) >= TLS_BLOCK_BYTES) {
                        issues.push(
                            `${site} resolves ${sym.name} to offset 0x${hex8(sym.value)}, ` +
                                `outside the ${TLS_BLOCK_BYTES}-byte HLE TLS block`
                        );
                        break;
                    }
                    seg.data.writeUInt32BE(TLS_MODULE_ID, offset);
                    appliedCounts.set(rel.type, (appliedCounts.get(rel.type) || 0) + 1);
                    recordTlsSymbol(sym, sym.value);
                    tlsSites.push({
                        addr,
                        section: seg.name,
                        type: relocationName(rel.type),
                        symbol: sym.name,
                        value: TLS_MODULE_ID,
                    });
                    break;
                }
                case R_PPC_DTPREL32: {
                    const problem = tlsSymbolIssue(site, sym);
                    if (problem) {
                        issues.push(problem);
                        break;
                    }
                    const value = ((sym.value >>> 0) + (rel.addend >>> 0)) >>> 0;
                    if (value >= TLS_BLOCK_BYTES || value + (sym.size >>> 0) > TLS_BLOCK_BYTES) {
                        issues.push(
                            `${site} resolves ${sym.name}+${rel.addend >>> 0} to ` +
                                `0x${hex8(value)} (+${sym.size} bytes), outside the ` +
                                `${TLS_BLOCK_BYTES}-byte HLE TLS block`
                        );
                        break;
                    }
                    seg.data.writeUInt32BE(value, offset);
                    appliedCounts.set(rel.type, (appliedCounts.get(rel.type) || 0) + 1);
                    recordTlsSymbol(sym, value);
                    tlsSites.push({
                        addr,
                        section: seg.name,
                        type: relocationName(rel.type),
                        symbol: sym.name,
                        value,
                    });
                    break;
                }
                default:
                    issues.push(`${site} in ${seg.name} is not supported`);
                    break;
            }
        }
    }

    if (issues.length > 0) throw new ImageError(issues);

    if (codeSites > 0) {
        notes.push(
            `${codeSites} relocation site(s) in executable sections belong to the recompiler; ` +
                `executable section bytes are mapped for data fidelity only and keep their link-time values`
        );
    }
    if (tlsSites.length > 0) {
        const symbols = [...tlsSymbols.values()]
            .sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name))
            .map((s) => `${s.name}@${s.offset}`)
            .join(", ");
        notes.push(
            `${tlsSites.length} TLS relocation site(s) applied for main module ` +
                `${TLS_MODULE_ID} (${symbols}); the zero-filled HLE block is ` +
                `${TLS_BLOCK_BYTES} bytes`
        );
    }

    let bytes = 0;
    let payloadBytes = 0;
    let bssBytes = 0;
    for (const seg of segments) {
        bytes += seg.size;
        if (seg.flags & IMAGE_FLAG_BSS) bssBytes += seg.size;
        else payloadBytes += seg.size;
    }

    return {
        segments,
        relocations: {
            applied: [...appliedCounts.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([type, count]) => ({ type, name: relocationName(type), count })),
            code: codeSites,
            none: noneSites,
        },
        tls: {
            module: TLS_MODULE_ID,
            blockBytes: TLS_BLOCK_BYTES,
            sites: tlsSites,
            symbols: [...tlsSymbols.values()].sort(
                (a, b) => a.offset - b.offset || a.name.localeCompare(b.name)
            ),
        },
        notes,
        stats: { sections: segments.length, bytes, payloadBytes, bssBytes },
    };
}

/**
 * Serializes a load plan into a PPCXIMG1 blob. Segments must already be in
 * ascending address order and must not overlap (buildImage guarantees both).
 */
function serializeImage(plan) {
    const segments = plan.segments || [];
    const issues = [];
    if (segments.length === 0) issues.push("the plan has no segments");
    if (segments.length > IMAGE_MAX_SEGMENTS) {
        issues.push(`too many segments (${segments.length} > ${IMAGE_MAX_SEGMENTS})`);
    }
    let prevEnd = 0;
    let payloadOffset = IMAGE_HEADER_SIZE + segments.length * IMAGE_ENTRY_SIZE;
    for (const seg of segments) {
        const addr = seg.addr >>> 0;
        const size = seg.size >>> 0;
        if (size === 0) issues.push(`segment ${seg.name} has size 0`);
        if (addr + size > ARENA_BYTES) {
            issues.push(`segment ${seg.name} (0x${hex8(addr)}+${size}) leaves the guest arena`);
        }
        if (addr < prevEnd) {
            issues.push(`segment ${seg.name} at 0x${hex8(addr)} overlaps the previous segment`);
        }
        if (((seg.flags >>> 0) & ~IMAGE_FLAG_KNOWN) !== 0) {
            issues.push(`segment ${seg.name} has unknown flags 0x${(seg.flags >>> 0).toString(16)}`);
        }
        if (seg.flags & IMAGE_FLAG_BSS) {
            if (seg.data) issues.push(`segment ${seg.name} is BSS but carries a payload`);
        } else if (!seg.data || seg.data.length !== size) {
            issues.push(`segment ${seg.name} payload does not match its size (${size})`);
        }
        prevEnd = Math.max(prevEnd, addr + size);
    }
    if (issues.length > 0) throw new ImageError(issues);

    let total = IMAGE_HEADER_SIZE + segments.length * IMAGE_ENTRY_SIZE;
    for (const seg of segments) {
        if (!(seg.flags & IMAGE_FLAG_BSS)) total += seg.size;
    }

    const blob = Buffer.alloc(total);
    IMAGE_MAGIC.copy(blob, 0);
    blob.writeUInt32BE(segments.length, 8);
    blob.writeUInt32BE(0, 12); /* checksum, filled below */
    segments.forEach((seg, i) => {
        const entry = IMAGE_HEADER_SIZE + i * IMAGE_ENTRY_SIZE;
        const bss = (seg.flags & IMAGE_FLAG_BSS) !== 0;
        blob.writeUInt32BE(seg.addr >>> 0, entry);
        blob.writeUInt32BE(seg.size >>> 0, entry + 4);
        blob.writeUInt32BE(bss ? 0 : payloadOffset, entry + 8);
        blob.writeUInt32BE(seg.flags >>> 0, entry + 12);
        if (!bss) {
            seg.data.copy(blob, payloadOffset);
            payloadOffset += seg.size;
        }
    });
    const tableEnd = IMAGE_HEADER_SIZE + segments.length * IMAGE_ENTRY_SIZE;
    blob.writeUInt32BE(fletcher32(blob.subarray(tableEnd)), 12);
    return blob;
}

/**
 * Validating reader for PPCXIMG1 blobs. Mirrors the checks the C loader
 * performs; used by tests and tooling.
 */
function readImageBlob(buf) {
    if (buf.length < IMAGE_HEADER_SIZE) {
        throw new ImageError(`blob is ${buf.length} bytes, shorter than the ${IMAGE_HEADER_SIZE}-byte header`);
    }
    if (!buf.subarray(0, 8).equals(IMAGE_MAGIC)) {
        throw new ImageError("bad image magic (expected PPCXIMG1)");
    }
    const count = buf.readUInt32BE(8);
    const checksum = buf.readUInt32BE(12);
    if (count === 0 || count > IMAGE_MAX_SEGMENTS) {
        throw new ImageError(`bad segment count ${count}`);
    }
    const tableEnd = IMAGE_HEADER_SIZE + count * IMAGE_ENTRY_SIZE;
    if (tableEnd > buf.length) {
        throw new ImageError("the segment table runs past the end of the blob");
    }
    const segments = [];
    let prevEnd = 0;
    for (let i = 0; i < count; i++) {
        const entry = IMAGE_HEADER_SIZE + i * IMAGE_ENTRY_SIZE;
        const addr = buf.readUInt32BE(entry);
        const size = buf.readUInt32BE(entry + 4);
        const payloadOffset = buf.readUInt32BE(entry + 8);
        const flags = buf.readUInt32BE(entry + 12);
        if (size === 0) throw new ImageError(`segment ${i} is empty`);
        if ((flags & ~IMAGE_FLAG_KNOWN) !== 0) {
            throw new ImageError(`segment ${i} has unknown flags 0x${(flags >>> 0).toString(16)}`);
        }
        if (addr + size > ARENA_BYTES) {
            throw new ImageError(`segment ${i} (0x${hex8(addr)}+${size}) leaves the guest arena`);
        }
        if (addr < prevEnd) {
            throw new ImageError(`segment ${i} at 0x${hex8(addr)} overlaps the previous segment`);
        }
        if (!(flags & IMAGE_FLAG_BSS) && payloadOffset + size > buf.length) {
            throw new ImageError(`the payload of segment ${i} runs past the end of the blob`);
        }
        prevEnd = addr + size;
        segments.push({ index: i, addr, size, payloadOffset, flags });
    }
    if (fletcher32(buf.subarray(tableEnd)) !== checksum) {
        throw new ImageError("payload checksum mismatch");
    }
    return { count, checksum, tableEnd, segments };
}

module.exports = {
    buildImage,
    serializeImage,
    readImageBlob,
    fletcher32,
    ImageError,
    IMAGE_MAGIC,
    IMAGE_HEADER_SIZE,
    IMAGE_ENTRY_SIZE,
    IMAGE_MAX_SEGMENTS,
    IMAGE_FLAG_BSS,
    IMAGE_FLAG_WRITE,
    ARENA_BYTES,
    relocationName,
};
