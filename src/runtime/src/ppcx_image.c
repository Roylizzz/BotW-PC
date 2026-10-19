/*
 * Runtime loader for the PPCXIMG1 image blob written by `tools/ppcx image`.
 *
 * The blob is a derived artifact of the user's own game dump: it lives under
 * build/ and is never committed. See src/runtime/README.md for the error
 * codes and ppcx_image.h for the format.
 *
 * When the checked memory model is active (ppcx_mem.h) the loader registers
 * every segment in its region map before mapping anything, so a loaded image
 * is exactly the set of guest addresses the translated code may touch.
 *
 * This C code is original to the BotW-PC project and licensed under MIT.
 */

#include "ppcx_image.h"
#include "ppcx_mem.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PPCX_IMAGE_HEADER_SIZE 16u
#define PPCX_IMAGE_ENTRY_SIZE 16u

/* The blob is a local derived artifact; anything beyond this cap is a bug. */
#define PPCX_IMAGE_MAX_BYTES (1024u * 1024u * 1024u)

static const char ppcx_image_magic[8] = { 'P', 'P', 'C', 'X', 'I', 'M', 'G', '1' };

static u32 ppcx_image_rd32(const u8 *p) {
    return ((u32)p[0] << 24) | ((u32)p[1] << 16) | ((u32)p[2] << 8) | (u32)p[3];
}

u32 ppcx_image_fletcher32(const u8 *data, size_t len) {
    u32 a = 0xffffu;
    u32 b = 0xffffu;
    size_t i = 0;
    while (i < len) {
        size_t n = len - i > 359u ? 359u : len - i;
        size_t k;
        for (k = 0; k < n; k++, i++) {
            a += data[i];
            b += a;
        }
        a = (a & 0xffffu) + (a >> 16);
        b = (b & 0xffffu) + (b >> 16);
    }
    a = (a & 0xffffu) + (a >> 16);
    b = (b & 0xffffu) + (b >> 16);
    a = (a & 0xffffu) + (a >> 16);
    b = (b & 0xffffu) + (b >> 16);
    return (b << 16) | a;
}

#define PPCX_IMAGE_FAIL(code, ...)                                          \
    do {                                                                    \
        if (err != NULL && err_cap > 0u) {                                  \
            snprintf(err, err_cap, __VA_ARGS__);                            \
        }                                                                   \
        return (code);                                                      \
    } while (0)

long ppcx_image_load_memory(const u8 *blob, size_t len, PpcxImageReport *report, char *err, size_t err_cap) {
    u32 count;
    u32 stored_checksum;
    size_t table_end;
    u64 mapped = 0;
    u64 payload = 0;
    u64 prev_end = 0;
    unsigned bss = 0;
    unsigned i;

    if (err != NULL && err_cap > 0u) err[0] = '\0';
    if (blob == NULL || report == NULL) {
        PPCX_IMAGE_FAIL(-1, "invalid arguments");
    }
    memset(report, 0, sizeof *report);
    if (ppcx_memory == NULL) {
        PPCX_IMAGE_FAIL(-1, "the guest arena is not allocated (call ppcx_runtime_init first)");
    }

    /* --- validate the whole structure before writing anything --------- */
    if (len < PPCX_IMAGE_HEADER_SIZE) {
        PPCX_IMAGE_FAIL(-2, "blob is shorter than the %u-byte header", (unsigned)PPCX_IMAGE_HEADER_SIZE);
    }
    if (memcmp(blob, ppcx_image_magic, 8) != 0) {
        PPCX_IMAGE_FAIL(-2, "bad image magic (expected PPCXIMG1)");
    }
    count = ppcx_image_rd32(blob + 8);
    stored_checksum = ppcx_image_rd32(blob + 12);
    if (count == 0u || count > PPCX_IMAGE_MAX_SEGMENTS) {
        PPCX_IMAGE_FAIL(-3, "bad segment count %u", (unsigned)count);
    }
    table_end = (size_t)PPCX_IMAGE_HEADER_SIZE + (size_t)count * PPCX_IMAGE_ENTRY_SIZE;
    if (table_end > len) {
        PPCX_IMAGE_FAIL(-4, "the segment table runs past the end of the blob");
    }

    for (i = 0; i < count; i++) {
        const u8 *entry = blob + PPCX_IMAGE_HEADER_SIZE + (size_t)i * PPCX_IMAGE_ENTRY_SIZE;
        u32 addr = ppcx_image_rd32(entry);
        u32 size = ppcx_image_rd32(entry + 4);
        u32 offset = ppcx_image_rd32(entry + 8);
        u32 flags = ppcx_image_rd32(entry + 12);
        if (size == 0u) {
            PPCX_IMAGE_FAIL(-5, "segment %u is empty", (unsigned)i);
        }
        if ((flags & ~PPCX_IMAGE_FLAG_BSS) != 0u) {
            PPCX_IMAGE_FAIL(-5, "segment %u has unknown flags 0x%08X", (unsigned)i, (unsigned)flags);
        }
        if ((u64)addr + (u64)size > (u64)PPCX_ARENA_BYTES) {
            PPCX_IMAGE_FAIL(-5, "segment %u (0x%08X+%u) leaves the guest arena",
                            (unsigned)i, (unsigned)addr, (unsigned)size);
        }
        if ((u64)addr < prev_end) {
            PPCX_IMAGE_FAIL(-6, "segment %u at 0x%08X overlaps the previous segment",
                            (unsigned)i, (unsigned)addr);
        }
        if ((flags & PPCX_IMAGE_FLAG_BSS) != 0u) {
            bss++;
        } else {
            if ((u64)offset + (u64)size > (u64)len) {
                PPCX_IMAGE_FAIL(-7, "the payload of segment %u runs past the end of the blob", (unsigned)i);
            }
            payload += size;
        }
        mapped += size;
        prev_end = (u64)addr + (u64)size;
    }
    if (ppcx_image_fletcher32(blob + table_end, len - table_end) != stored_checksum) {
        PPCX_IMAGE_FAIL(-8, "payload checksum mismatch");
    }

    /*
     * --- register the live regions (before any byte is written) ---------
     * Only when the runtime installed the checked memory model; in raw
     * harnesses the loader leaves no trace beyond the arena bytes.
     */
    if (ppcx_mem_active) {
        for (i = 0; i < count; i++) {
            const u8 *entry = blob + PPCX_IMAGE_HEADER_SIZE + (size_t)i * PPCX_IMAGE_ENTRY_SIZE;
            u32 addr = ppcx_image_rd32(entry);
            u32 size = ppcx_image_rd32(entry + 4);
            if (ppcx_mem_add(addr, size, "image") != 0) {
                PPCX_IMAGE_FAIL(-10, "segment %u (0x%08X+%u) cannot be registered as a live region",
                                (unsigned)i, (unsigned)addr, (unsigned)size);
            }
        }
    }

    /* --- map it -------------------------------------------------------- */
    for (i = 0; i < count; i++) {
        const u8 *entry = blob + PPCX_IMAGE_HEADER_SIZE + (size_t)i * PPCX_IMAGE_ENTRY_SIZE;
        u32 addr = ppcx_image_rd32(entry);
        u32 size = ppcx_image_rd32(entry + 4);
        u32 offset = ppcx_image_rd32(entry + 8);
        u32 flags = ppcx_image_rd32(entry + 12);
        if ((flags & PPCX_IMAGE_FLAG_BSS) != 0u) {
            memset(ppcx_memory + addr, 0, size);
        } else {
            memcpy(ppcx_memory + addr, blob + offset, size);
        }
    }

    report->segments = (unsigned)count;
    report->bss_segments = bss;
    report->bytes = mapped;
    report->payload_bytes = payload;
    return 0;
}

long ppcx_image_load_file(const char *path, PpcxImageReport *report, char *err, size_t err_cap) {
    FILE *f;
    long size;
    u8 *blob;
    size_t got;
    long rc;

    if (err != NULL && err_cap > 0u) err[0] = '\0';
    if (path == NULL || report == NULL) {
        PPCX_IMAGE_FAIL(-1, "invalid arguments");
    }
    f = fopen(path, "rb");
    if (f == NULL) {
        PPCX_IMAGE_FAIL(-9, "cannot open %s", path);
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        PPCX_IMAGE_FAIL(-9, "cannot seek in %s", path);
    }
    size = ftell(f);
    if (size <= 0 || (unsigned long)size > PPCX_IMAGE_MAX_BYTES) {
        fclose(f);
        PPCX_IMAGE_FAIL(-9, "%s is not a usable image (%ld bytes)", path, size);
    }
    rewind(f);
    blob = (u8 *)malloc((size_t)size);
    if (blob == NULL) {
        fclose(f);
        PPCX_IMAGE_FAIL(-1, "out of memory for the %ld-byte image", size);
    }
    got = fread(blob, 1, (size_t)size, f);
    fclose(f);
    if (got != (size_t)size) {
        free(blob);
        PPCX_IMAGE_FAIL(-9, "short read from %s", path);
    }
    rc = ppcx_image_load_memory(blob, (size_t)size, report, err, err_cap);
    free(blob);
    return rc;
}
