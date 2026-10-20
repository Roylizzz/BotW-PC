/*
 * Minimal runtime for the statically recompiled RPX code (prototype).
 *
 * What this iteration does:
 *   - allocates one flat arena covering the whole guest address space;
 *   - models guest memory as a region map (ppcx_mem.c): the stack, the
 *     reserved HLE data page and every loaded image segment; once installed
 *     (ppcx_run), any access outside every region stops with a diagnostic and
 *     exit code 9 instead of silently reading or writing unrelated arena
 *     bytes;
 *   - resolves guest addresses to translated functions by binary search
 *     over the generated registry;
 *   - gives address-taken imports stable pseudo-addresses in a reserved
 *     region and routes both `PPCX_IMPORT_ADDR` dispatches and direct
 *     `PPCX_HLE` calls into the HLE layer;
 *   - stops with a precise diagnostic when execution reaches code that
 *     has no translation, a target with no registered function, or a guest
 *     trap instruction (tw).
 *
 * A typed coreinit/proc_ui/clock/input HLE registry is modeled (ppcx_hle.c);
 * other imports are counted and left untouched in diagnostic mode, and strict
 * mode rejects them. `PPCX_HLE_TRACE=1` logs each call and
 * `PPCX_HLE_STRICT=1` aborts on the first unimplemented one.
 * `PPCX_DISPATCH_TRACE=1` logs every control transfer that goes through the
 * runtime dispatcher, which makes it possible to find the last translated
 * function executed before a crash. `PPCX_FN_TRACE=1` prints every
 * translated-function entry (the generated code must be built with
 * ppcx_trace_enter calls) and `PPCX_CRASH_TRACE=1` installs a Windows crash
 * handler that dumps the event ring of recent entries when the host takes an
 * access violation.
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ppcx_abi.h"
#include "ppcx_hle.h"
#include "ppcx_image.h"
#include "ppcx_mem.h"
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

/* Initial guest stack pointer for ad-hoc entry points, and the size of the
 * checked stack region mapped below it. The loader calls the entry point
 * with a valid ABI frame, so the initial SP sits PPCX_INITIAL_FRAME bytes
 * below the mapped top and the entry's own prologue can save LR at SP+4 of
 * that frame (with SP exactly at the top, the first real prologue faults;
 * found by the tests/boot fixture). */
#define PPCX_INITIAL_STACK 0x10000000u
#define PPCX_STACK_BYTES 0x00100000u
#define PPCX_INITIAL_FRAME 16u

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

/*
 * Checked-memory fault hook: ppcx_mem.c prints the deterministic diagnostic
 * and then calls this to add the current register context before exiting.
 */
static const Cpu *g_fault_cpu;

static void ppcx_mem_fault_dump(u32 ea, unsigned size, unsigned write) {
    (void)ea;
    (void)size;
    (void)write;
    if (g_fault_cpu != NULL) {
        ppcx_dump_state(g_fault_cpu);
    }
}

void ppcx_dispatch(Cpu *c, u32 target) {
    g_fault_cpu = c;
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
    if (ppcx_hle_dispatch_named(c, name)) {
        if (g_trace) {
            fprintf(stderr, "ppcx: HLE modeled #%u: %s (import %u), r3=0x%08X\n",
                    g_hle_calls, name, (unsigned)import_index, (unsigned)c->gpr[3]);
        }
        return;
    }
    if (g_strict) {
        fprintf(stderr, "ppcx: unimplemented HLE: %s (import %u) in strict mode\n",
                name, (unsigned)import_index);
        ppcx_dump_state(c);
        exit(5);
    }
    if (g_trace) {
        fprintf(stderr, "ppcx: HLE unimplemented #%u: %s (import %u) [diagnostic no-op]\n",
                g_hle_calls, name, (unsigned)import_index);
    }
    /* Diagnostic compatibility only: unknown services do NOT work. */
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
    ppcx_hle_procui_reset();
    ppcx_hle_clock_reset();
    ppcx_hle_input_reset();
    memset(&cpu, 0, sizeof(cpu));
    /*
     * Install the checked guest-memory model before anything runs: the
     * stack region is mapped here and the image loader registers every
     * segment it maps. Without PPCX_IMAGE any data access faults
     * deterministically (exit code 9, see ppcx_mem.h) instead of reading
     * unrelated zero bytes.
     */
    g_fault_cpu = &cpu;
    ppcx_mem_set_fault_hook(ppcx_mem_fault_dump);
    ppcx_mem_reset(PPCX_INITIAL_STACK, PPCX_STACK_BYTES);
    /*
     * Reserve the one guest page that backs HLE data returned to the game
     * (currently the OSSystemInfo record). It sits below the loaded image and
     * the stack; a module that maps that address is rejected instead of
     * silently aliasing it.
     */
    if (ppcx_mem_add_perm(PPCX_HLE_DATA_ADDR, PPCX_HLE_DATA_SIZE, "hle-data",
                          PPCX_MEM_WRITE) != 0) {
        fprintf(stderr, "ppcx: cannot map the HLE data page at 0x%08X\n",
                (unsigned)PPCX_HLE_DATA_ADDR);
        return 8;
    }
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
    cpu.gpr[1] = PPCX_INITIAL_STACK - PPCX_INITIAL_FRAME;
    fprintf(stderr, "ppcx: entry 0x%08X, %u translated function(s)\n",
            (unsigned)ppcx_entry, ppcx_function_count);
    ppcx_dispatch(&cpu, ppcx_entry);
    fprintf(stderr, "ppcx: entry returned, r3 = 0x%08X\n", (unsigned)cpu.gpr[3]);
    fprintf(stderr, "ppcx: HLE calls: %u (unimplemented services remain)\n", g_hle_calls);
    return 0;
}
