/* Source-owned synthetic test for explicit Cafe OS HLE dispatch (MIT). */
#include "ppcx_hle.h"
#include <stdio.h>
#include <string.h>

static int fail(const char *message) {
    fprintf(stderr, "hle: %s\n", message);
    return 1;
}

int main(void) {
    static const struct {
        const char *name;
        u32 result;
    } known[] = {
        { "coreinit.OSGetCoreCount", 3u },
        { "coreinit.OSGetCoreId", 1u },
        { "coreinit.OSGetMainCoreId", 1u },
        { "coreinit.OSIsMainCore", 1u },
    };
    Cpu cpu;
    Cpu before;
    unsigned i;
    for (i = 0; i < sizeof(known) / sizeof(known[0]); i++) {
        memset(&cpu, 0x5a, sizeof cpu);
        cpu.gpr[3] = 0xdeadbeefu;
        before = cpu;
        if (ppcx_hle_dispatch_named(&cpu, known[i].name) != 1) return fail("known import unresolved");
        if (cpu.gpr[3] != known[i].result) return fail("incorrect return value in r3");
        before.gpr[3] = known[i].result;
        if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("unintended register mutation");
    }

    memset(&cpu, 0x55, sizeof cpu);
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIInit") != 0) return fail("nonimplemented function reported implemented");
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("unknown function changed CPU");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSGetCoreIdSuffix") != 0) return fail("non-exact match was accepted");
    if (ppcx_hle_dispatch_named(&cpu, "other.OSGetCoreId") != 0) return fail("incorrect module accepted");
    if (ppcx_hle_dispatch_named(&cpu, NULL) != 0 || ppcx_hle_dispatch_named(NULL, "coreinit.OSGetCoreId") != 0) return fail("invalid args");
    puts("hle: four modeled core services, exact matching and register preservation OK");
    return 0;
}
