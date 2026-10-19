#ifndef PPCX_MEM_H
#define PPCX_MEM_H

/*
 * Checked guest-memory model (RUN-003).
 *
 * Guest memory starts out with no model installed: the accessors in
 * ppcx_abi.h read and write the arena flat, which is what the synthetic ISA
 * harness relies on. ppcx_mem_reset installs the model:
 *
 *   - the region map is cleared and the stack region is added;
 *   - ppcx_mem_active becomes 1, so every guest access must fall entirely
 *     inside one mapped region;
 *   - an access outside every region, or a write to a region without
 *     PPCX_MEM_WRITE, prints one deterministic diagnostic line on stderr
 *     and terminates the process with exit code 9, after running the
 *     optional fault hook (the runtime uses it to dump the current register
 *     context).
 *
 * The image loader (ppcx_image.c) registers every loaded segment with
 * ppcx_mem_add_perm while the model is active, so a loaded image is exactly
 * the set of guest addresses the translated code may touch. Without an image
 * only the stack is mapped, which turns silent reads of unloaded data into
 * loud faults instead of zero words.
 *
 * Regions carry permissions: every region is readable and a write is only
 * allowed when the region was registered with PPCX_MEM_WRITE. The image
 * loader derives the permission from the ELF section flags stored in the
 * blob, so `.text` and the read-only metadata sections reject writes while
 * `.data`, `.bss` and the stack accept them. A rejected write faults exactly
 * like an access outside every region (same diagnostic shape, fault hook and
 * exit code).
 *
 * This C code is original to the BotW-PC project and licensed under MIT.
 */

#include "ppcx_abi.h"

#define PPCX_MEM_MAX_REGIONS 128u
#define PPCX_MEM_WRITE 0x1u

typedef void (*PpcxMemFaultHook)(u32 ea, unsigned size, unsigned write);

/*
 * Clears the map, activates checking and maps [stack_top - stack_size,
 * stack_top) as the "stack" region. A stack_size of zero (or one larger
 * than stack_top) installs no stack region.
 */
void ppcx_mem_reset(u32 stack_top, u32 stack_size);

/*
 * Registers [start, start + size) as a live region. Returns 0 on success,
 * -1 when it partially overlaps an existing region, -2 when the table is
 * full, -3 for an invalid range (empty, outside the guest arena) or unknown
 * permission bits, and -4 when an exact duplicate carries different
 * permissions. Registering an exact duplicate with the same permissions is a
 * success, so mapping the same image twice is idempotent.
 *
 * `ppcx_mem_add` is the read/write shorthand kept for existing callers; the
 * image loader uses `ppcx_mem_add_perm` with the permission derived from the
 * segment flags. The tag string is stored by reference and must outlive the
 * map (all callers pass string literals).
 */
int ppcx_mem_add(u32 start, u32 size, const char *tag);
int ppcx_mem_add_perm(u32 start, u32 size, const char *tag, unsigned perm);

/* Fault reporting: the hook runs after the diagnostic, before exit(9). */
void ppcx_mem_set_fault_hook(PpcxMemFaultHook hook);

/* Introspection for tests and diagnostics (0-based, insertion sorted). */
unsigned ppcx_mem_region_count(void);
int ppcx_mem_region_at(unsigned index, u32 *start, u32 *size, const char **tag);
int ppcx_mem_region_permissions(unsigned index, unsigned *perm);

#endif
