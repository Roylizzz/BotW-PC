#ifndef PPCX_HLE_H
#define PPCX_HLE_H

/* Original MIT code: typed subset of Wii U Cafe OS import behavior.
 * No external game data is required to compile or test this layer.
 */
#include "ppcx_abi.h"

/* Return 1 if implemented, 0 if not recognized. Unrecognized imports MUST
 * be handled by the caller's strict/diagnostic policy, never represented as
 * successful HLE implementations. */
int ppcx_hle_dispatch_named(Cpu *cpu, const char *qualified_name);

#endif
