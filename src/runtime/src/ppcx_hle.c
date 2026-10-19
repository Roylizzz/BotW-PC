/*
 * Small, exact-name Cafe OS HLE registry. MIT, original implementation.
 *
 * Currently models core identity only. This single-thread prototype pins
 * its only executing guest context to Wii U's main PPC core (id 1).
 * It is NOT a scheduler, and no other Cafe OS imports are implemented here.
 *
 * API return contracts checked against devkitPro/wut coreinit/core.h.
 */
#include "ppcx_hle.h"

#include <string.h>

typedef void (*PpcxHleHandler)(Cpu *);

typedef struct PpcxHleEntry {
    const char *name;
    PpcxHleHandler handler;
} PpcxHleEntry;

static void hle_core_count(Cpu *cpu) { cpu->gpr[3] = 3u; }
static void hle_core_id(Cpu *cpu) { cpu->gpr[3] = 1u; }
static void hle_main_core_id(Cpu *cpu) { cpu->gpr[3] = 1u; }
static void hle_is_main_core(Cpu *cpu) { cpu->gpr[3] = 1u; }

static const PpcxHleEntry hle_registry[] = {
    { "coreinit.OSGetCoreCount", hle_core_count },
    { "coreinit.OSGetCoreId", hle_core_id },
    { "coreinit.OSGetMainCoreId", hle_main_core_id },
    { "coreinit.OSIsMainCore", hle_is_main_core },
};

int ppcx_hle_dispatch_named(Cpu *cpu, const char *qualified_name) {
    unsigned i;
    if (cpu == NULL || qualified_name == NULL) return 0;
    for (i = 0; i < sizeof(hle_registry) / sizeof(hle_registry[0]); i++) {
        if (strcmp(qualified_name, hle_registry[i].name) == 0) {
            hle_registry[i].handler(cpu);
            return 1;
        }
    }
    return 0;
}
