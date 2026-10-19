#ifndef PPCX_IMAGE_H
#define PPCX_IMAGE_H

/*
 * Loader for the PPCXIMG1 image blob written by `tools/ppcx image`
 * (see tools/ppcx/README.md). The blob maps every allocated section of the
 * user's own RPX (relocated, zero-filled) into the guest arena, exactly the
 * way the console loader prepares the address space before the first
 * instruction runs.
 *
 * Layout (all integers big-endian):
 *   offset 0   magic "PPCXIMG1"
 *   offset 8   segment count (1..PPCX_IMAGE_MAX_SEGMENTS)
 *   offset 12  Fletcher-32 of the payload region (bytes after the table)
 *   offset 16  segment table, 16 bytes per entry:
 *                addr, size, payload offset (0 for BSS), flags
 *                (bit 0 = BSS, bit 1 = writable; other bits are rejected)
 *   then       payloads in entry order, no padding
 *
 * The loader validates the whole structure and the payload checksum before
 * it writes anything, so a rejected blob cannot leave half an image behind.
 *
 * This C code is original to the BotW-PC project and licensed under MIT.
 */

#include <stddef.h>

#include "ppcx_abi.h"

#define PPCX_IMAGE_FLAG_BSS 0x1u
#define PPCX_IMAGE_FLAG_WRITE 0x2u
#define PPCX_IMAGE_MAX_SEGMENTS 1024u

typedef struct PpcxImageSegment {
    u32 addr;
    u32 size;
    u32 payload_offset;
    u32 flags;
} PpcxImageSegment;

typedef struct PpcxImageReport {
    unsigned segments;
    unsigned bss_segments;
    u64 bytes;         /* guest bytes covered by the image */
    u64 payload_bytes; /* bytes copied out of the blob */
} PpcxImageReport;

/*
 * Loads an in-memory blob / a blob file into the arena (which must have been
 * allocated: call ppcx_runtime_init first). Both return 0 on success or a
 * negative code (documented in src/runtime/README.md) and write a one-line
 * diagnostic into `err` when err_cap > 0.
 */
long ppcx_image_load_memory(const u8 *blob, size_t len, PpcxImageReport *report, char *err, size_t err_cap);
long ppcx_image_load_file(const char *path, PpcxImageReport *report, char *err, size_t err_cap);

/*
 * Fletcher-32 of the bytes (two 16-bit running sums, reduced every 359 bytes
 * so the 32-bit accumulators cannot overflow). The tool that writes blobs
 * runs the identical algorithm, so both sides agree byte for byte.
 */
u32 ppcx_image_fletcher32(const u8 *data, size_t len);

#endif
