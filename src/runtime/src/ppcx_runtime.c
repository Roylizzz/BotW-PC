/*
 * Minimal runtime for the statically recompiled RPX code (prototype).
 *
 * What this iteration does:
 *   - allocates one flat arena covering the whole guest address space;
 *   - resolves guest addresses to translated functions by binary search
 *     over the generated registry;
 *   - gives address-taken imports stable pseudo-addresses in a reserved
 *     region and routes both `PPCX_IMPORT_ADDR` dispatches and direct
 *     `PPCX_HLE` calls into the HLE layer;
 *   - stops with a precise diagnostic when execution reaches code that
 *     has no translation, a target with no registered function, or a guest
 *     trap instruction (tw).
 *
 * The operating system is not modelled yet: every HLE call is counted and
 * returns with the CPU untouched. `PPCX_HLE_TRACE=1` logs each call and
 * `PPCX_HLE_STRICT=1` aborts on the first one. `PPCX_DISPATCH_TRACE=1` logs
 * every control transfer that goes through the runtime dispatcher, which
 * makes it possible to find the last translated function executed before a
 * crash. `PPCX_FN_TRACE=1` prints every translated-function entry (the
 * generated code must be built with ppcx_trace_enter calls) and
 * `PPCX_CRASH_TRACE=1` installs a Windows crash handler that dumps the event
 * ring of recent entries when the host takes an access violation.
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ppcx_abi.h"
#include "ppcx_image.h"
#include "ppcx_runtime.h"

/*
 * The RPX is linked for addresses up to ~0xC1xxxxxx (the import slots sit
 * at 0xC0000000), so one arena covers the whole guest address space
 * (PPCX_ARENA_BYTES, shared with the image loader in ppcx_abi.h).
 */

/*
 * Address-taken imports get pseudo-addresses in a region no RPX section
 * uses: above .text (which ends at 0x04347C2C in v208) and below the
 * import slots (0xC0000000).
 */
#define PPCX_HLE_TRAMPOLINE_BASE 0x50000000u
#define PPCX_HLE_TRAMPOLINE_STRIDE 8u
#define PPCX_HLE_TRAMPOLINE_RANGE (0x10000u * PPCX_HLE_TRAMPOLINE_STRIDE)

/* Initial guest stack pointer for ad-hoc entry points. */
#define PPCX_INITIAL_STACK 0x10000000u

u8 *ppcx_memory = NULL;

static unsigned g_hle_calls;
static int g_trace;
static int g_strict;
static int g_dispatch_trace;
static int g_fn_trace;
static int g_initialized;

/* Ring of translated-function entries filled by ppcx_trace_enter. */
#define PPCX_FN_RING 1024u
static u32 g_fn_ring[PPCX_FN_RING];
static unsigned g_fn_entries;

void ppcx_trace_enter(u32 addr) {
    g_fn_ring[g_fn_entries & (PPCX_FN_RING - 1u)] = addr;
    g_fn_entries++;
    if (g_fn_trace) {
        fprintf(stderr, "ppcx: fn %u: 0x%08X\n", g_fn_entries, (unsigned)addr);
    }
}

#if defined(_WIN32)
/*
 * Minimal Windows declarations: the tcc kernel32 import set exposes
 * GetModuleHandleA/GetProcAddress but not AddVectoredExceptionHandler, so the
 * crash handler is registered dynamically. Only EXCEPTION_ACCESS_VIOLATION is
 * inspected; Rip is read from the x64 CONTEXT record (offset 0xF8).
 */
typedef void *PpcxHmodule;
PpcxHmodule __stdcall GetModuleHandleA(const char *name);
void *__stdcall GetProcAddress(PpcxHmodule module, const char *name);

typedef struct PpcxExceptionRecord {
    unsigned long ExceptionCode;
    unsigned long ExceptionFlags;
    struct PpcxExceptionRecord *ExceptionRecord;
    void *ExceptionAddress;
    unsigned long NumberParameters;
    unsigned long long ExceptionInformation[15];
} PpcxExceptionRecord;

typedef struct PpcxExceptionPointers {
    PpcxExceptionRecord *ExceptionRecord;
    void *ContextRecord;
} PpcxExceptionPointers;

typedef void *(__stdcall *PpcxVehHandler)(void *);
typedef void *(__stdcall *PpcxAddVeh)(unsigned long, PpcxVehHandler);

static void *__stdcall ppcx_crash_handler(void *raw) {
    PpcxExceptionPointers *info = (PpcxExceptionPointers *)raw;
    if (info != NULL && info->ExceptionRecord != NULL &&
        info->ExceptionRecord->ExceptionCode == 0xC0000005u) {
        static const char *const kinds[3] = { "read", "write", "execute" };
        unsigned long long kind = info->ExceptionRecord->ExceptionInformation[0];
        unsigned long long where = info->ExceptionRecord->ExceptionInformation[1];
        unsigned long long rip = 0;
        unsigned i;
        unsigned start;
        if (info->ContextRecord != NULL) {
            rip = *(unsigned long long *)((const char *)info->ContextRecord + 0xF8);
        }
        fprintf(stderr, "ppcx: host access violation: %s at 0x%llX (host rip 0x%llX)\n",
                kind < 3u ? kinds[kind] : "unknown", where, rip);
        start = g_fn_entries > 24u ? g_fn_entries - 24u : 0u;
        fprintf(stderr, "ppcx: last %u translated function entries:\n", g_fn_entries - start);
        for (i = start; i < g_fn_entries; i++) {
            fprintf(stderr, "  [%u] 0x%08X\n", i,
                    (unsigned)g_fn_ring[i & (PPCX_FN_RING - 1u)]);
        }
        fflush(stderr);
    }
    return (void *)0; /* EXCEPTION_CONTINUE_SEARCH */
}

static void ppcx_install_crash_handler(void) {
    PpcxHmodule kernel32 = GetModuleHandleA("kernel32.dll");
    PpcxAddVeh add = kernel32 != NULL
        ? (PpcxAddVeh)(void *)GetProcAddress(kernel32, "AddVectoredExceptionHandler")
        : (PpcxAddVeh)0;
    if (add != NULL && add(1u, ppcx_crash_handler) != NULL) {
        fprintf(stderr, "ppcx: crash trace installed (PPCX_CRASH_TRACE)\n");
    } else {
        fprintf(stderr, "ppcx: could not install the crash trace\n");
    }
}
#else
static void ppcx_install_crash_handler(void) {}
#endif

void ppcx_runtime_init(void) {
    if (g_initialized) return;
    g_initialized = 1;
    setvbuf(stderr, NULL, _IONBF, 0); /* diagnostics must survive a crash */
    g_trace = getenv("PPCX_HLE_TRACE") != NULL;
    g_strict = getenv("PPCX_HLE_STRICT") != NULL;
    g_dispatch_trace = getenv("PPCX_DISPATCH_TRACE") != NULL;
    g_fn_trace = getenv("PPCX_FN_TRACE") != NULL;
    if (getenv("PPCX_CRASH_TRACE") != NULL) {
        ppcx_install_crash_handler();
    }
    ppcx_memory = (u8 *)calloc(1, (size_t)PPCX_ARENA_BYTES);
    if (ppcx_memory == NULL) {
        fprintf(stderr, "ppcx: could not allocate the guest arena (%u bytes)\n",
                (unsigned)PPCX_ARENA_BYTES);
        exit(2);
    }
}

static const PpcxEntry *ppcx_find(u32 addr) {
    unsigned lo = 0;
    unsigned hi = ppcx_function_count;
    while (lo < hi) {
        unsigned mid = lo + (hi - lo) / 2;
        u32 a = ppcx_functions[mid].addr;
        if (a == addr) return &ppcx_functions[mid];
        if (a < addr) lo = mid + 1;
        else hi = mid;
    }
    return NULL;
}

static void ppcx_dump_state(const Cpu *c) {
    fprintf(stderr,
            "      r1 0x%08X  r2 0x%08X  r3 0x%08X  lr 0x%08X  ctr 0x%08X\n",
            (unsigned)c->gpr[1], (unsigned)c->gpr[2], (unsigned)c->gpr[3],
            (unsigned)c->lr, (unsigned)c->ctr);
}

void ppcx_dispatch(Cpu *c, u32 target) {
    if (g_dispatch_trace) {
        fprintf(stderr, "ppcx: dispatch 0x%08X\n", (unsigned)target);
    }
    if (target >= PPCX_HLE_TRAMPOLINE_BASE &&
        target < PPCX_HLE_TRAMPOLINE_BASE + PPCX_HLE_TRAMPOLINE_RANGE) {
        ppcx_hle_call(c, (target - PPCX_HLE_TRAMPOLINE_BASE) / PPCX_HLE_TRAMPOLINE_STRIDE);
        return;
    }
    {
        const PpcxEntry *entry = ppcx_find(target);
        if (entry == NULL) {
            ppcx_call_unknown(c, target);
            return;
        }
        entry->fn(c);
    }
}

void ppcx_unimpl(Cpu *c, u32 addr) {
    fprintf(stderr, "ppcx: reached an instruction with no translation yet (0x%08X)\n",
            (unsigned)addr);
    ppcx_dump_state(c);
    exit(3);
}

void ppcx_trap(Cpu *c, u32 addr, const char *name) {
    fprintf(stderr, "ppcx: guest trap (%s) at 0x%08X\n", name, (unsigned)addr);
    ppcx_dump_state(c);
    exit(6);
}

void ppcx_call_unknown(Cpu *c, u32 target) {
    fprintf(stderr, "ppcx: branch or call to an address with no registered function (0x%08X)\n",
            (unsigned)target);
    ppcx_dump_state(c);
    exit(4);
}

void ppcx_hle_call(Cpu *c, u32 import_index) {
    const char *name = ppcx_import_name(import_index);
    g_hle_calls++;
    if (g_strict) {
        fprintf(stderr, "ppcx: HLE call to %s (import %u) in strict mode\n",
                name, (unsigned)import_index);
        ppcx_dump_state(c);
        exit(5);
    }
    if (g_trace) {
        fprintf(stderr, "ppcx: HLE call #%u: %s (import %u)\n",
                g_hle_calls, name, (unsigned)import_index);
    }
    /* No model implemented yet: the call returns with the CPU untouched. */
}

u32 ppcx_import_addr(u32 import_index) {
    return PPCX_HLE_TRAMPOLINE_BASE + import_index * PPCX_HLE_TRAMPOLINE_STRIDE;
}

unsigned ppcx_hle_call_count(void) {
    return g_hle_calls;
}

int ppcx_run(void) {
    Cpu cpu;
    const char *image;
    ppcx_runtime_init();
    memset(&cpu, 0, sizeof(cpu));
    /*
     * Optional RPX load image (build/ppcx/image.bin, written by
     * `tools/ppcx image`): maps .rodata/.data/.bss so translated code can
     * read the game's own globals. Without PPCX_IMAGE the arena stays
     * empty, which is only enough for functions that touch no data.
     */
    image = getenv("PPCX_IMAGE");
    if (image != NULL && image[0] != '\0') {
        PpcxImageReport report;
        char err[256];
        long rc = ppcx_image_load_file(image, &report, err, sizeof err);
        if (rc != 0) {
            fprintf(stderr, "ppcx: image load failed (%ld): %s\n", rc, err);
            return 8;
        }
        fprintf(stderr, "ppcx: image %s mapped: %u segment(s), %llu bytes (%u BSS)\n",
                image, (unsigned)report.segments,
                (unsigned long long)report.bytes, (unsigned)report.bss_segments);
    }
    /* Modelled boot state: the system software leaves the quantized
     * load/store unit enabled (the shipped game code never writes HID2 and
     * still executes psq_* instructions, so LSQE must already be set). */
    cpu.hid2 = PPCX_HID2_LSQE;
    cpu.gpr[1] = PPCX_INITIAL_STACK;
    fprintf(stderr, "ppcx: entry 0x%08X, %u translated function(s)\n",
            (unsigned)ppcx_entry, ppcx_function_count);
    ppcx_dispatch(&cpu, ppcx_entry);
    fprintf(stderr, "ppcx: entry returned, r3 = 0x%08X\n", (unsigned)cpu.gpr[3]);
    fprintf(stderr, "ppcx: HLE calls: %u (no models implemented yet)\n", g_hle_calls);
    return 0;
}
