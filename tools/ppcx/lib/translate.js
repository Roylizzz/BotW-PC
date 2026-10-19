"use strict";

/**
 * PowerPC -> C translator for RPX game code (first iteration).
 *
 * The translator turns one function range into one C function with this
 * signature:
 *
 *     static void f_XXXXXXXX(Cpu *c);
 *
 * Design notes (why the generated code looks the way it does):
 *
 *   - Guest memory is a flat 32-bit address space at a fixed host base, so
 *     effective addresses are computed in 32-bit arithmetic and passed to
 *     the `ppcx_rd*`/`ppcx_wr*` accessors from the ABI header.
 *
 *   - Update-form loads/stores (`lwzu`, `stwu`, ...) write the computed
 *     effective address into rA. The emitted order matches the ISA: loads
 *     write rA first (a load into rA wins), stores read their value first.
 *
 *   - `bl` to an import site (R_PPC_REL24 relocation against a `.fimport_*`
 *     slot) becomes a direct HLE call. `bl`/`b` to a translated function
 *     becomes a C call / tail call. Other targets dispatch at runtime.
 *
 *   - `blr` becomes `return;`: returns follow the C call structure, which is
 *     equivalent for regular call/return code. Non-local returns (setjmp /
 *     longjmp patterns) are a documented Phase 3 gap.
 *
 *   - `bclr`/`bcctr`/`bc` with out-of-range targets stop running this
 *     function and hand the target to the runtime dispatcher.
 *
 *   - Unsupported instructions emit a PPCX_UNIMPL trap that names the exact
 *     address, so execution stops with a useful diagnostic instead of
 *     silently skipping a side effect.
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

const { decode } = require("./decode.js");

const hex8 = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
const fnName = (addr) => `f_${hex8(addr)}`;
const labelName = (addr) => `L_${hex8(addr)}`;
const u32hex = (n) => `0x${(n >>> 0).toString(16)}u`;
const addrHex = (n) => `0x${hex8(n).toLowerCase()}u`;

const FPR_SIGN = "0x8000000000000000ull";

function branchTarget(ins) {
    const disp = ins.branch === "bc" ? ins.bd : ins.li;
    if (ins.aa) return disp >>> 0;
    return (ins.addr + disp) >>> 0;
}

function asSet(v, fallback) {
    if (v instanceof Set) return v;
    if (Array.isArray(v)) return new Set(v);
    return fallback;
}

/**
 * Translates one function range.
 *
 * Required options:
 *   data     Buffer with the .text bytes (any offset base)
 *   base     virtual address of data[0]
 *   start    function start address
 *   end      exclusive end address (next function start)
 *   textBase / textEnd   bounds of the whole .text section
 *
 * Optional:
 *   startSet   Set of all known function starts (for callee classification)
 *   emitSet    Set of addresses that will have bodies in this translation
 *              unit (calls to those become direct C calls)
 *   callSite   Map: instruction address -> import index (REL24 sites)
 *   dataSite   Map: relocation offset (instruction + 2) -> { index, type }
 */
function translateFunction(opts) {
    const {
        data,
        base,
        start,
        end,
        textBase = base,
        textEnd = base + data.length,
        callSite = new Map(),
        dataSite = new Map(),
    } = opts;
    const startSet = asSet(opts.startSet, new Set([start]));
    const emitSet = asSet(opts.emitSet, new Set([start]));

    const name = fnName(start);
    const lines = [];
    const warnings = [];
    const unsupported = new Map();
    const callees = new Map();
    const labels = new Set();
    const hleCalls = [];
    const importAddrs = [];
    const externalTargets = new Set();

    let needsEa = false;

    // ---------------------------------------------------------------- pass 1
    const instrs = [];
    for (let addr = start; addr < end; addr += 4) {
        const ins = decode(data.readUInt32BE(addr - base));
        ins.addr = addr;
        instrs.push(ins);
        if (ins.branch === "b" || ins.branch === "bc") {
            const t = branchTarget(ins);
            if (t >= start && t < end) labels.add(t);
        }
        if (!ins.supported) {
            unsupported.set(ins.name, (unsupported.get(ins.name) || 0) + 1);
        } else if (ins.update) {
            needsEa = true;
        }
    }

    // ---------------------------------------------------------------- helpers
    const g = (n) => `c->gpr[${n}]`;
    const d0 = (n) => `c->fpr[${n}].ps0.d`;
    const u0 = (n) => `c->fpr[${n}].ps0.u`;
    const d1 = (n) => `c->fpr[${n}].ps1.d`;
    const u1 = (n) => `c->fpr[${n}].ps1.u`;
    const FILL = (n, v) => `PPCX_FILL_SINGLE(c->fpr[${n}], ${v})`;

    const emit = (s) => lines.push(`    ${s}`);
    const emitRaw = (s) => lines.push(s);

    /* Emits a nested block: runs `body` and indents everything it emitted. */
    const emitBlock = (body) => {
        const saved = lines.length;
        body();
        for (let i = saved; i < lines.length; i++) lines[i] = `    ${lines[i]}`;
    };

    /* OE forms of the XO instructions: the operands are captured before the
     * result store because rT may alias rA or rB, and the overflow is defined
     * by the original operand values. `capture` declares the locals that
     * `result` and `ovExpr` use. */
    const emitOe = (capture, result, ovExpr) => {
        emit("{");
        emit(`    ${capture}`);
        emit(`    ${result}`);
        emit(`    ppcx_set_ov(c, ${ovExpr});`);
        emit("}");
    };

    const immHex = (ins) => u32hex(ins.imm);
    /* cmpli takes its immediate as an unsigned halfword. */
    const uimmHex = (ins) => `0x${(ins.uimm >>> 0).toString(16)}u`;
    const dEA = (ins) => (ins.ra === 0 ? immHex(ins) : `(u32)(${g(ins.ra)} + ${immHex(ins)})`);
    const xEA = (ins) => (ins.ra === 0 ? g(ins.rb) : `(u32)(${g(ins.ra)} + ${g(ins.rb)})`);

    function loadExpr(access, ea, reg) {
        switch (access) {
            case "u32":
                return `${g(reg)} = ppcx_rd32(${ea});`;
            case "u8":
                return `${g(reg)} = ppcx_rd8(${ea});`;
            case "u16":
                return `${g(reg)} = ppcx_rd16(${ea});`;
            case "s16":
                return `${g(reg)} = (u32)(s32)(s16)ppcx_rd16(${ea});`;
            case "host32":
                return `${g(reg)} = ppcx_rd32_host(${ea});`;
            case "host16":
                return `${g(reg)} = ppcx_rd16_host(${ea});`;
            case "f32":
                return `PPCX_FILL_SINGLE(c->fpr[${reg}], ppcx_bits_f32(ppcx_rd32(${ea})));`;
            case "f64":
                return `${u0(reg)} = ppcx_rd64(${ea});`;
            default:
                throw new Error(`unknown load access: ${access}`);
        }
    }

    function storeExpr(access, ea, reg) {
        switch (access) {
            case "u32":
                return `ppcx_wr32(${ea}, ${g(reg)});`;
            case "u8":
                return `ppcx_wr8(${ea}, (u8)${g(reg)});`;
            case "u16":
                return `ppcx_wr16(${ea}, (u16)${g(reg)});`;
            case "host32":
                return `ppcx_wr32_host(${ea}, ${g(reg)});`;
            case "host16":
                return `ppcx_wr16_host(${ea}, (u16)${g(reg)});`;
            case "f32":
                return `ppcx_wr32(${ea}, ppcx_single_bits_from_bits(${u0(reg)}));`;
            case "f64":
                return `ppcx_wr64(${ea}, ${u0(reg)});`;
            case "fpu-lo32":
                return `ppcx_wr32(${ea}, (u32)${u0(reg)});`;
            default:
                throw new Error(`unknown store access: ${access}`);
        }
    }

    function memoryIns(ins) {
        return ins.kind === "load" || ins.kind === "store";
    }

    function emitMemory(ins) {
        const ea = ins.form === "D" ? dEA(ins) : xEA(ins);
        const reg = ins.frd !== undefined ? ins.frd : ins.rt;
        if (ins.update) {
            emit(`ea = ${ea};`);
            if (ins.kind === "load") {
                emit(`${g(ins.ra)} = ea;`);
                emit(loadExpr(ins.access, "ea", reg));
            } else {
                emit(storeExpr(ins.access, "ea", reg));
                emit(`${g(ins.ra)} = ea;`);
            }
        } else if (ins.kind === "load") {
            emit(loadExpr(ins.access, ea, reg));
        } else {
            emit(storeExpr(ins.access, ea, reg));
        }
    }

    /* Quantized paired-single load/store: the GQR-driven conversion lives in
     * the runtime helpers; the translator only computes the effective address
     * and, for the update forms, the rA write-back. */
    function emitPsq(ins) {
        const fn = ins.kind === "load" ? "ppcx_psq_l" : "ppcx_psq_st";
        const args = `${ins.i}u, ${ins.w}u, ${ins.frd}u, ${addrHex(ins.addr)}`;
        const ea =
            ins.form === "PSQ"
                ? ins.update || ins.ra !== 0
                    ? `(u32)(${g(ins.ra)} + ${u32hex(ins.disp)})`
                    : u32hex(ins.disp)
                : xEA(ins);
        if (!ins.update) {
            emit(`${fn}(c, ${ea}, ${args});`);
            return;
        }
        emit(`ea = ${ea};`);
        if (ins.kind === "load") emit(`${g(ins.ra)} = ea;`);
        emit(`${fn}(c, ea, ${args});`);
        if (ins.kind === "store") emit(`${g(ins.ra)} = ea;`);
    }

    function addCallee(target, kind) {
        if (target < textBase || target >= textEnd) return;
        if (target >= start && target < end) return;
        if (!startSet.has(target)) {
            warnings.push(`branch to 0x${hex8(target)} which is not a known function start`);
            return;
        }
        const rec = callees.get(target) || { addr: target, bl: 0, b: 0 };
        if (kind === "bl") rec.bl++;
        else rec.b++;
        callees.set(target, rec);
    }

    /* Emits the call body for a branch whose return address has already been
     * written into LR (bl, bcl). `addCallee` records the target; when the
     * callee has no body in this translation unit it is dispatched or
     * reported at run time. */
    function emitLinkedCall(target) {
        const inText = target >= textBase && target < textEnd;
        addCallee(target, "bl");
        if (!emitSet.has(target)) externalTargets.add(target);
        if (emitSet.has(target)) emit(`${fnName(target)}(c);`);
        else if (inText) emit(`PPCX_DISPATCH(c, ${addrHex(target)});`);
        else emit(`PPCX_CALL_UNKNOWN(c, ${addrHex(target)});`);
    }

    function emitCallExternal(ins, target, kind) {
        const ret = addrHex(ins.addr + 4);
        addCallee(target, kind);
        if (!emitSet.has(target)) externalTargets.add(target);
        const inText = target >= textBase && target < textEnd;
        if (kind === "bl") {
            emit(`c->lr = ${ret};`);
            emitLinkedCall(target);
            return false;
        }
        // Tail branch.
        if (emitSet.has(target)) {
            emit(`PPCX_TAILCALL(c, ${fnName(target)});`);
        } else if (inText) {
            emit(`PPCX_DISPATCH(c, ${addrHex(target)});`);
            emit("return;");
        } else {
            emit(`PPCX_CALL_UNKNOWN(c, ${addrHex(target)});`);
            emit("return;");
        }
        return true;
    }

    function emitTailExternal(ins, target) {
        // Like emitCallExternal but without a link register update.
        const inText = target >= textBase && target < textEnd;
        addCallee(target, "b");
        if (!emitSet.has(target)) externalTargets.add(target);
        if (emitSet.has(target)) {
            emit(`PPCX_TAILCALL(c, ${fnName(target)});`);
        } else if (inText) {
            emit(`PPCX_DISPATCH(c, ${addrHex(target)});`);
            emit("return;");
        } else {
            emit(`PPCX_CALL_UNKNOWN(c, ${addrHex(target)});`);
            emit("return;");
        }
        return true;
    }

    // ---------------------------------------------------------------- pass 2
    emitRaw(`/* ${fnName(start)}: 0x${hex8(start)}..0x${hex8(end)} (${(end - start) / 4} instructions) */`);
    emitRaw(`static void ${name}(Cpu *c) {`);
    if (needsEa) emit("u32 ea;");

    let lastTransfer = false;

    for (const ins of instrs) {
        if (labels.has(ins.addr)) emitRaw(`${labelName(ins.addr)}:;`);

        if (ins.kind === "load-multi" || ins.kind === "store-multi") {
            /* lmw/stmw: the effective address is evaluated once, then the
             * helper walks the register range (see ppcx_lmw/ppcx_stmw). */
            const ea = dEA(ins);
            if (ins.kind === "load-multi") emit(`ppcx_lmw(c, ${ea}, ${ins.rt}u);`);
            else emit(`ppcx_stmw(c, ${ea}, ${ins.rt}u);`);
            continue;
        }

        if (ins.access === "psq") {
            emitPsq(ins);
            continue;
        }

        if (memoryIns(ins)) {
            emitMemory(ins);
            continue;
        }

        let rcExpr = null;
        lastTransfer = false;

        if (ins.branch === "bl" || ins.branch === "b") {
            const target = branchTarget(ins);
            if (callSite.has(ins.addr)) {
                const idx = callSite.get(ins.addr);
                hleCalls.push(idx);
                if (ins.branch === "bl") {
                    emit(`c->lr = ${addrHex(ins.addr + 4)};`);
                    emit(`PPCX_HLE(c, ${idx});`);
                } else {
                    /* `b` to an import: tail call, returns to our caller. */
                    emit(`PPCX_HLE(c, ${idx});`);
                    emit("return;");
                    lastTransfer = true;
                }
                continue;
            }
            if (target >= start && target < end) {
                if (ins.branch === "bl") {
                    warnings.push(`bl inside the function body (0x${hex8(target)}); dispatched at runtime`);
                    emit(`c->lr = ${addrHex(ins.addr + 4)};`);
                    emit(`PPCX_DISPATCH(c, ${addrHex(target)});`);
                } else {
                    emit(`goto ${labelName(target)};`);
                    lastTransfer = true;
                }
                continue;
            }
            lastTransfer = emitCallExternal(ins, target, ins.branch);
            continue;
        }

        if (ins.branch === "bc") {
            const target = branchTarget(ins);
            const uncond = (ins.bo & 0x14) === 0x14;
            const cond = `ppcx_bc(c, ${u32hex(ins.bo)}, ${u32hex(ins.bi)})`;
            const lk = ins.lk === true;

            if (target >= start && target < end) {
                if (lk) {
                    /* bcl to a mid-function label: the target has no C body,
                     * so hand it to the runtime dispatcher with LR set. */
                    warnings.push(`bcl inside the function body (0x${hex8(target)}); dispatched at runtime`);
                    if (uncond) {
                        emit(`c->lr = ${addrHex(ins.addr + 4)};`);
                        emit(`PPCX_DISPATCH(c, ${addrHex(target)});`);
                    } else {
                        emit(`if (${cond}) {`);
                        emit(`    c->lr = ${addrHex(ins.addr + 4)};`);
                        emit(`    PPCX_DISPATCH(c, ${addrHex(target)});`);
                        emit("}");
                    }
                    continue;
                }
                if (uncond) {
                    emit(`goto ${labelName(target)};`);
                } else {
                    emit(`if (${cond}) goto ${labelName(target)};`);
                }
                lastTransfer = uncond;
                continue;
            }

            if (lk) {
                /* Branch conditional and link: LR is written only when the
                 * branch is taken, then the target runs as a call. */
                if (uncond) {
                    emit(`c->lr = ${addrHex(ins.addr + 4)};`);
                    emitLinkedCall(target);
                } else {
                    emit(`if (${cond}) {`);
                    emit(`    c->lr = ${addrHex(ins.addr + 4)};`);
                    emitBlock(() => emitLinkedCall(target));
                    emit("}");
                }
                lastTransfer = false; /* a call returns to the next instruction */
                continue;
            }

            if (uncond) {
                lastTransfer = emitTailExternal(ins, target);
            } else {
                emit(`if (${cond}) {`);
                emitBlock(() => emitTailExternal(ins, target));
                emit("}");
                lastTransfer = false; // conditional: control may fall through
            }
            continue;
        }

        if (ins.branch === "blr") {
            /* Regular return: control returns through the C call stack. */
            emit("return;");
            lastTransfer = true;
            continue;
        }

        if (
            ins.branch === "bclr" ||
            ins.branch === "bclrl" ||
            ins.branch === "bctr" ||
            ins.branch === "bcctr"
        ) {
            const isCtr = ins.branch === "bctr" || ins.branch === "bcctr";
            const reg = isCtr ? "c->ctr" : "c->lr";
            const uncond = (ins.bo & 0x14) === 0x14;
            const cond = `ppcx_bc(c, ${u32hex(ins.bo)}, ${u32hex(ins.bi)})`;
            if (ins.lk) {
                /* Branch with link: the target returns into this function. */
                emit(uncond ? "{" : `if (${cond}) {`);
                emit(`    u32 t = ${reg} & ~3u;`);
                emit(`    c->lr = ${addrHex(ins.addr + 4)};`);
                emit("    PPCX_DISPATCH(c, t);");
                emit("}");
                lastTransfer = false;
            } else if (!isCtr) {
                /* bclr without link: return, possibly conditional. */
                if (uncond) emit("return;");
                else emit(`if (${cond}) return;`);
                lastTransfer = uncond;
            } else {
                /* bctr without link: indirect tail branch through the dispatcher. */
                emit(uncond ? "{" : `if (${cond}) {`);
                emit("    PPCX_DISPATCH(c, c->ctr & ~3u);");
                emit("    return;");
                emit("}");
                lastTransfer = uncond;
            }
            continue;
        }

        // ------------------------------------------------- D-form arithmetic
        switch (ins.name) {
            case "nop":
                continue;
            case "mulli":
                /* The D-form mulli immediate is signed, unlike the unsigned
                 * logical immediates of the ori family. */
                emit(`${g(ins.rt)} = (u32)((s64)(s32)${g(ins.ra)} * (s64)(s32)${immHex(ins)});`);
                break;
            case "subfic":
                /* RA = 0 selects r0 itself here (unlike addi/addis, where
                 * RA = 0 means the literal zero). */
                emit(`ppcx_subfic(c, ${ins.rt}, ${g(ins.ra)}, ${immHex(ins)});`);
                break;
            case "cmpi":
                emit(`ppcx_cmp(c, ${ins.crf}, ${g(ins.ra)}, ${immHex(ins)});`);
                break;
            case "cmpli":
                emit(`ppcx_cmpl(c, ${ins.crf}, ${g(ins.ra)}, ${uimmHex(ins)});`);
                break;
            case "addic":
            case "addic.":
                emit(`ppcx_addic(c, ${ins.rt}, ${g(ins.ra)}, ${immHex(ins)});`);
                if (ins.name === "addic.") emit(`ppcx_cr0(c, ${g(ins.rt)});`);
                break;
            case "addi":
            case "addis": {
                const site = dataSite.get(ins.addr + 2);
                let value = ins.name === "addi" ? immHex(ins) : u32hex(ins.imm << 16);
                if (site) {
                    const imp = `PPCX_IMPORT_ADDR(${site.index})`;
                    /* Address-taken imports are runtime dependencies too: the
                     * unit mentions their index and the dispatcher trampoline
                     * resolves it through ppcx_import_name at run time. */
                    const noteImportAddr = () => {
                        if (!importAddrs.includes(site.index)) importAddrs.push(site.index);
                    };
                    if (site.type === 6 && ins.name === "addis") {
                        value = `(${imp} + 0x8000u) & 0xffff0000u`;
                        noteImportAddr();
                    } else if (site.type === 4 && ins.name === "addi") {
                        value = `(u32)(s32)(${imp} & 0xffffu)`;
                        noteImportAddr();
                    } else if (site.type === 5 && ins.name === "addis") {
                        value = `(u32)(${imp} >> 16) << 16`;
                        noteImportAddr();
                    } else {
                        warnings.push(`unexpected relocation type ${site.type} on ${ins.name} at 0x${hex8(ins.addr)}`);
                    }
                }
                if (ins.ra === 0) emit(`${g(ins.rt)} = ${value};`);
                else emit(`${g(ins.rt)} = ${g(ins.ra)} + ${value};`);
                break;
            }
            case "ori":
                emit(`${g(ins.ra)} = ${g(ins.rt)} | 0x${ins.uimm.toString(16)}u;`);
                break;
            case "oris":
                emit(`${g(ins.ra)} = ${g(ins.rt)} | ${u32hex(ins.uimm << 16)};`);
                break;
            case "xori":
                emit(`${g(ins.ra)} = ${g(ins.rt)} ^ 0x${ins.uimm.toString(16)}u;`);
                break;
            case "xoris":
                emit(`${g(ins.ra)} = ${g(ins.rt)} ^ ${u32hex(ins.uimm << 16)};`);
                break;
            case "andi.":
                emit(`${g(ins.ra)} = ${g(ins.rt)} & 0x${ins.uimm.toString(16)}u;`);
                emit(`ppcx_cr0(c, ${g(ins.ra)});`);
                break;
            case "andis.":
                emit(`${g(ins.ra)} = ${g(ins.rt)} & ${u32hex(ins.uimm << 16)};`);
                emit(`ppcx_cr0(c, ${g(ins.ra)});`);
                break;

            // ---------------------------------------------------- M-form rotate
            case "rlwinm":
                emit(`${g(ins.ra)} = ppcx_rlwinm(${g(ins.rs)}, ${ins.sh}u, ${ins.mb}u, ${ins.me}u);`);
                rcExpr = g(ins.ra);
                break;
            case "rlwimi":
                emit(`${g(ins.ra)} = ppcx_rlwimi(${g(ins.ra)}, ${g(ins.rs)}, ${ins.sh}u, ${ins.mb}u, ${ins.me}u);`);
                rcExpr = g(ins.ra);
                break;
            case "rlwnm":
                emit(`${g(ins.ra)} = ppcx_rlwinm(${g(ins.rs)}, ${g(ins.rb)} & 31u, ${ins.mb}u, ${ins.me}u);`);
                rcExpr = g(ins.ra);
                break;

            // ------------------------------------------------- opcode 19 / XL
            case "mcrf":
                emit(`ppcx_cr_set_hex(c, ${ins.crfd}u, ppcx_cr_field(c, ${ins.crfs}u));`);
                break;
            case "isync":
                emit("PPCX_FENCE_ISYNC();");
                break;
            case "crand":
            case "crandc":
            case "creqv":
            case "crnand":
            case "crnor":
            case "cror":
            case "crorc":
            case "crxor": {
                const A = `ppcx_cr_bit(c, ${ins.crfa}u)`;
                const B = `ppcx_cr_bit(c, ${ins.crfb}u)`;
                let expr;
                switch (ins.name) {
                    case "crand":
                        expr = `${A} & ${B}`;
                        break;
                    case "crandc":
                        expr = `${A} & (${B} ^ 1u)`;
                        break;
                    case "creqv":
                        expr = `${A} ^ ${B} ^ 1u`;
                        break;
                    case "crnand":
                        expr = `(${A} & ${B}) ^ 1u`;
                        break;
                    case "crnor":
                        expr = `(${A} | ${B}) ^ 1u`;
                        break;
                    case "cror":
                        expr = `${A} | ${B}`;
                        break;
                    case "crorc":
                        expr = `${A} | (${B} ^ 1u)`;
                        break;
                    default:
                        expr = `${A} ^ ${B}`;
                        break;
                }
                emit(`ppcx_cr_setbit(c, ${ins.crfd}u, ${expr});`);
                break;
            }

            // ------------------------------------------------- opcode 31 (X)
            case "add":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)}, y = ${g(ins.rb)};`,
                        `${g(ins.rt)} = x + y;`,
                        `ppcx_ov_add(x, y, ${g(ins.rt)})`
                    );
                } else {
                    emit(`${g(ins.rt)} = ${g(ins.ra)} + ${g(ins.rb)};`);
                }
                rcExpr = g(ins.rt);
                break;
            case "addc":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)}, y = ${g(ins.rb)};`,
                        `ppcx_addc(c, ${ins.rt}, x, y);`,
                        `ppcx_ov_add(x, y, ${g(ins.rt)})`
                    );
                } else {
                    emit(`ppcx_addc(c, ${ins.rt}, ${g(ins.ra)}, ${g(ins.rb)});`);
                }
                rcExpr = g(ins.rt);
                break;
            case "adde":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)}, y = ${g(ins.rb)};`,
                        `ppcx_adde(c, ${ins.rt}, x, y);`,
                        `ppcx_ov_add(x, y, ${g(ins.rt)})`
                    );
                } else {
                    emit(`ppcx_adde(c, ${ins.rt}, ${g(ins.ra)}, ${g(ins.rb)});`);
                }
                rcExpr = g(ins.rt);
                break;
            case "addme":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)};`,
                        `ppcx_addme(c, ${ins.rt}, x);`,
                        `ppcx_ov_add(x, 0xffffffffu, ${g(ins.rt)})`
                    );
                } else {
                    emit(`ppcx_addme(c, ${ins.rt}, ${g(ins.ra)});`);
                }
                rcExpr = g(ins.rt);
                break;
            case "addze":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)};`,
                        `ppcx_addze(c, ${ins.rt}, x);`,
                        `ppcx_ov_add(x, 0u, ${g(ins.rt)})`
                    );
                } else {
                    emit(`ppcx_addze(c, ${ins.rt}, ${g(ins.ra)});`);
                }
                rcExpr = g(ins.rt);
                break;
            case "subf":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)}, y = ${g(ins.rb)};`,
                        `${g(ins.rt)} = y - x;`,
                        `ppcx_ov_add(~x, y, ${g(ins.rt)})`
                    );
                } else {
                    emit(`${g(ins.rt)} = ${g(ins.rb)} - ${g(ins.ra)};`);
                }
                rcExpr = g(ins.rt);
                break;
            case "subfc":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)}, y = ${g(ins.rb)};`,
                        `ppcx_subfc(c, ${ins.rt}, x, y);`,
                        `ppcx_ov_add(~x, y, ${g(ins.rt)})`
                    );
                } else {
                    emit(`ppcx_subfc(c, ${ins.rt}, ${g(ins.ra)}, ${g(ins.rb)});`);
                }
                rcExpr = g(ins.rt);
                break;
            case "subfe":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)}, y = ${g(ins.rb)};`,
                        `ppcx_subfe(c, ${ins.rt}, x, y);`,
                        `ppcx_ov_add(~x, y, ${g(ins.rt)})`
                    );
                } else {
                    emit(`ppcx_subfe(c, ${ins.rt}, ${g(ins.ra)}, ${g(ins.rb)});`);
                }
                rcExpr = g(ins.rt);
                break;
            case "subfme":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)};`,
                        `ppcx_subfme(c, ${ins.rt}, x);`,
                        `ppcx_ov_add(~x, 0xffffffffu, ${g(ins.rt)})`
                    );
                } else {
                    emit(`ppcx_subfme(c, ${ins.rt}, ${g(ins.ra)});`);
                }
                rcExpr = g(ins.rt);
                break;
            case "subfze":
                if (ins.oe) {
                    emitOe(
                        `u32 x = ${g(ins.ra)};`,
                        `ppcx_subfze(c, ${ins.rt}, x);`,
                        `ppcx_ov_add(~x, 0u, ${g(ins.rt)})`
                    );
                } else {
                    emit(`ppcx_subfze(c, ${ins.rt}, ${g(ins.ra)});`);
                }
                rcExpr = g(ins.rt);
                break;
            case "neg":
                if (ins.oe) {
                    /* The references set OV only for the most negative value
                     * (there is no add-like operand pair to test). */
                    emitOe(
                        `u32 x = ${g(ins.ra)};`,
                        `ppcx_neg(c, ${ins.rt}, x);`,
                        "x == 0x80000000u"
                    );
                } else {
                    emit(`ppcx_neg(c, ${ins.rt}, ${g(ins.ra)});`);
                }
                rcExpr = g(ins.rt);
                break;
            case "mullw":
                if (ins.oe) {
                    /* OE form: the overflow is a width property of the full
                     * 64-bit product, so compute it before truncating. */
                    emit("{");
                    emit(`    s64 t = (s64)(s32)${g(ins.ra)} * (s64)(s32)${g(ins.rb)};`);
                    emit(`    ${g(ins.rt)} = (u32)t;`);
                    emit(`    ppcx_set_ov(c, (s64)(s32)${g(ins.rt)} != t);`);
                    emit("}");
                } else {
                    emit(`${g(ins.rt)} = ${g(ins.ra)} * ${g(ins.rb)};`);
                }
                rcExpr = g(ins.rt);
                break;
            case "mulhw":
                emit(`${g(ins.rt)} = (u32)(((s64)(s32)${g(ins.ra)} * (s64)(s32)${g(ins.rb)}) >> 32);`);
                rcExpr = g(ins.rt);
                break;
            case "mulhwu":
                emit(`${g(ins.rt)} = (u32)(((u64)${g(ins.ra)} * (u64)${g(ins.rb)}) >> 32);`);
                rcExpr = g(ins.rt);
                break;
            case "divw":
                emit(`ppcx_divw(c, ${ins.rt}, ${g(ins.ra)}, ${g(ins.rb)}, ${ins.oe ? 1 : 0});`);
                rcExpr = g(ins.rt);
                break;
            case "divwu":
                emit(`ppcx_divwu(c, ${ins.rt}, ${g(ins.ra)}, ${g(ins.rb)}, ${ins.oe ? 1 : 0});`);
                rcExpr = g(ins.rt);
                break;
            case "and":
                emit(`${g(ins.ra)} = ${g(ins.rt)} & ${g(ins.rb)};`);
                rcExpr = g(ins.ra);
                break;
            case "andc":
                emit(`${g(ins.ra)} = ${g(ins.rt)} & ~${g(ins.rb)};`);
                rcExpr = g(ins.ra);
                break;
            case "or":
                emit(`${g(ins.ra)} = ${g(ins.rt)} | ${g(ins.rb)};`);
                rcExpr = g(ins.ra);
                break;
            case "orc":
                emit(`${g(ins.ra)} = ${g(ins.rt)} | ~${g(ins.rb)};`);
                rcExpr = g(ins.ra);
                break;
            case "xor":
                emit(`${g(ins.ra)} = ${g(ins.rt)} ^ ${g(ins.rb)};`);
                rcExpr = g(ins.ra);
                break;
            case "nand":
                emit(`${g(ins.ra)} = ~(${g(ins.rt)} & ${g(ins.rb)});`);
                rcExpr = g(ins.ra);
                break;
            case "nor":
                emit(`${g(ins.ra)} = ~(${g(ins.rt)} | ${g(ins.rb)});`);
                rcExpr = g(ins.ra);
                break;
            case "eqv":
                emit(`${g(ins.ra)} = ~(${g(ins.rt)} ^ ${g(ins.rb)});`);
                rcExpr = g(ins.ra);
                break;
            case "slw":
                emit(`${g(ins.ra)} = ppcx_slw(${g(ins.rt)}, ${g(ins.rb)});`);
                rcExpr = g(ins.ra);
                break;
            case "srw":
                emit(`${g(ins.ra)} = ppcx_srw(${g(ins.rt)}, ${g(ins.rb)});`);
                rcExpr = g(ins.ra);
                break;
            case "sraw":
                emit(`ppcx_sraw(c, ${ins.ra}, ${g(ins.rt)}, ${g(ins.rb)});`);
                rcExpr = g(ins.ra);
                break;
            case "srawi":
                emit(`ppcx_srawi(c, ${ins.ra}, ${g(ins.rt)}, ${ins.sh}u);`);
                rcExpr = g(ins.ra);
                break;
            case "cntlzw":
                emit(`${g(ins.ra)} = ppcx_cntlzw(${g(ins.rt)});`);
                rcExpr = g(ins.ra);
                break;
            case "extsb":
                emit(`${g(ins.ra)} = ppcx_sext8(${g(ins.rt)});`);
                rcExpr = g(ins.ra);
                break;
            case "extsh":
                emit(`${g(ins.ra)} = ppcx_sext16(${g(ins.rt)});`);
                rcExpr = g(ins.ra);
                break;
            case "cmp":
                emit(`ppcx_cmp(c, ${ins.crf}, ${g(ins.ra)}, ${g(ins.rb)});`);
                break;
            case "cmpl":
                emit(`ppcx_cmpl(c, ${ins.crf}, ${g(ins.ra)}, ${g(ins.rb)});`);
                break;
            case "tw":
                emit(`ppcx_tw(c, ${u32hex(ins.to)}, ${g(ins.ra)}, ${g(ins.rb)}, ${addrHex(ins.addr)});`);
                break;
            case "mfspr":
            case "mftb":
                emit(`${g(ins.rt)} = ppcx_mfspr(c, ${ins.spr}u);`);
                break;
            case "mtspr":
                emit(`ppcx_mtspr(c, ${ins.spr}u, ${g(ins.rt)});`);
                break;
            case "mfcr":
                emit(`${g(ins.rt)} = c->cr;`);
                break;
            case "mtcrf":
                emit(`ppcx_mtcrf(c, ${g(ins.rs)}, 0x${ins.fm.toString(16)}u);`);
                break;
            case "lwarx":
                emit(`${g(ins.rt)} = ppcx_lwarx(c, ${xEA(ins)});`);
                break;
            case "stwcx.":
                emit(`ppcx_stwcx(c, ${xEA(ins)}, ${g(ins.rs)});`);
                break;
            case "sync":
                emit("PPCX_FENCE_SYNC();");
                break;
            case "lwsync":
                emit("PPCX_FENCE_LWSYNC();");
                break;
            case "eieio":
                emit("PPCX_FENCE_EIEIO();");
                break;
            case "dcbf":
            case "dcbst":
                emit(`/* ${ins.name} 0x...: cache hint ignored */`);
                break;
            case "dcbz":
                emit(`ppcx_dcbz(${xEA(ins)});`);
                break;
            case "lswi":
                emit(`ppcx_lswi(c, ${ins.ra === 0 ? "0u" : g(ins.ra)}, ${ins.rt}u, ${ins.nb}u);`);
                break;
            case "stswi":
                emit(`ppcx_stswi(c, ${ins.ra === 0 ? "0u" : g(ins.ra)}, ${ins.rt}u, ${ins.nb}u);`);
                break;

            // -------------------------------------------------- floating point
            case "fdiv":
                emit(`${d0(ins.frd)} = ${d0(ins.fra)} / ${d0(ins.frb)};`);
                break;
            case "fsub":
                emit(`${d0(ins.frd)} = ${d0(ins.fra)} - ${d0(ins.frb)};`);
                break;
            case "fadd":
                emit(`${d0(ins.frd)} = ${d0(ins.fra)} + ${d0(ins.frb)};`);
                break;
            case "fsqrt":
                emit(`${d0(ins.frd)} = sqrt(${d0(ins.frb)});`);
                break;
            case "fsel":
                emit(`${d0(ins.frd)} = ppcx_fsel(${d0(ins.fra)}, ${d0(ins.frb)}, ${d0(ins.frc)});`);
                break;
            case "fmul":
                emit(`${d0(ins.frd)} = ${d0(ins.fra)} * ${d0(ins.frc)};`);
                break;
            case "fmsub":
                emit(`${d0(ins.frd)} = ppcx_fma_d(${d0(ins.fra)}, ${d0(ins.frc)}, -${d0(ins.frb)});`);
                break;
            case "fmadd":
                emit(`${d0(ins.frd)} = ppcx_fma_d(${d0(ins.fra)}, ${d0(ins.frc)}, ${d0(ins.frb)});`);
                break;
            case "fnmsub":
                emit(`${d0(ins.frd)} = ppcx_neg_unless_nan_d(ppcx_fma_d(${d0(ins.fra)}, ${d0(ins.frc)}, -${d0(ins.frb)}));`);
                break;
            case "fnmadd":
                emit(`${d0(ins.frd)} = ppcx_neg_unless_nan_d(ppcx_fma_d(${d0(ins.fra)}, ${d0(ins.frc)}, ${d0(ins.frb)}));`);
                break;

            case "fdivs":
                emit(`${FILL(ins.frd, `(float)(${d0(ins.fra)} / ${d0(ins.frb)})`)};`);
                break;
            case "fsubs":
                emit(`${FILL(ins.frd, `(float)(${d0(ins.fra)} - ${d0(ins.frb)})`)};`);
                break;
            case "fadds":
                emit(`${FILL(ins.frd, `(float)(${d0(ins.fra)} + ${d0(ins.frb)})`)};`);
                break;
            case "fsqrts":
                emit(`${FILL(ins.frd, `(float)sqrt(${d0(ins.frb)})`)};`);
                break;
            case "fmuls":
                emit(`${FILL(ins.frd, `(float)(${d0(ins.fra)} * ${d0(ins.frc)})`)};`);
                break;
            case "fmsubs":
                emit(`${FILL(ins.frd, `ppcx_fma_s(${d0(ins.fra)}, ${d0(ins.frc)}, -${d0(ins.frb)})`)};`);
                break;
            case "fmadds":
                emit(`${FILL(ins.frd, `ppcx_fma_s(${d0(ins.fra)}, ${d0(ins.frc)}, ${d0(ins.frb)})`)};`);
                break;
            case "fnmsubs":
                emit(
                    `${FILL(ins.frd, `ppcx_neg_unless_nan_s(ppcx_fma_s(${d0(ins.fra)}, ${d0(ins.frc)}, -${d0(ins.frb)}))`)};`
                );
                break;
            case "fnmadds":
                emit(
                    `${FILL(ins.frd, `ppcx_neg_unless_nan_s(ppcx_fma_s(${d0(ins.fra)}, ${d0(ins.frc)}, ${d0(ins.frb)}))`)};`
                );
                break;

            case "fcmpu":
            case "fcmpo":
                emit(`ppcx_fcmp(c, ${ins.crf}, ${d0(ins.fra)}, ${d0(ins.frb)});`);
                break;
            case "frsp":
                emit(`${FILL(ins.frd, `(float)${d0(ins.frb)}`)};`);
                break;
            case "fctiw":
                emit(`${u0(ins.frd)} = ppcx_fctiw_result(${d0(ins.frb)}, 0);`);
                break;
            case "fctiwz":
                emit(`${u0(ins.frd)} = ppcx_fctiw_result(${d0(ins.frb)}, 1);`);
                break;
            case "fneg":
                emit(`${d0(ins.frd)} = -${d0(ins.frb)};`);
                break;
            case "fnabs":
                emit(`${d0(ins.frd)} = -fabs(${d0(ins.frb)});`);
                break;
            case "fabs":
                emit(`${d0(ins.frd)} = fabs(${d0(ins.frb)});`);
                break;
            case "fmr":
                emit(`c->fpr[${ins.frd}].ps0 = c->fpr[${ins.frb}].ps0;`);
                break;
            case "fctidz":
                emit(`${u0(ins.frd)} = ppcx_fctidz_result(${d0(ins.frb)});`);
                break;
            case "fcfid":
                emit(`${d0(ins.frd)} = (double)(s64)${u0(ins.frb)};`);
                break;
            case "fres":
                emit(`${d0(ins.frd)} = ppcx_res_d(${d0(ins.frb)});`);
                break;
            case "frsqrte":
                emit(`${d0(ins.frd)} = ppcx_rsqrte_d(${d0(ins.frb)});`);
                break;
            case "frsqrtes":
                emit(`${FILL(ins.frd, `(float)ppcx_rsqrte_d(${d0(ins.frb)})`)};`);
                break;

            // ------------------------------------------------- paired single
            case "ps_sum0":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)(${d0(ins.fra)} + ${d1(ins.frb)}), (float)${d1(ins.frc)});`
                );
                break;
            case "ps_sum1":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)${d0(ins.frc)}, (float)(${d0(ins.fra)} + ${d1(ins.frb)}));`
                );
                break;
            case "ps_muls0":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)(${d0(ins.fra)} * ${d0(ins.frc)}), (float)(${d1(ins.fra)} * ${d0(ins.frc)}));`
                );
                break;
            case "ps_muls1":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)(${d0(ins.fra)} * ${d1(ins.frc)}), (float)(${d1(ins.fra)} * ${d1(ins.frc)}));`
                );
                break;
            case "ps_madds0":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], ppcx_fma_s(${d0(ins.fra)}, ${d0(ins.frc)}, ${d0(ins.frb)}), ppcx_fma_s(${d1(ins.fra)}, ${d0(ins.frc)}, ${d1(ins.frb)}));`
                );
                break;
            case "ps_madds1":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], ppcx_fma_s(${d0(ins.fra)}, ${d1(ins.frc)}, ${d0(ins.frb)}), ppcx_fma_s(${d1(ins.fra)}, ${d1(ins.frc)}, ${d1(ins.frb)}));`
                );
                break;
            case "ps_div":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)(${d0(ins.fra)} / ${d0(ins.frb)}), (float)(${d1(ins.fra)} / ${d1(ins.frb)}));`
                );
                break;
            case "ps_sub":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)(${d0(ins.fra)} - ${d0(ins.frb)}), (float)(${d1(ins.fra)} - ${d1(ins.frb)}));`
                );
                break;
            case "ps_add":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)(${d0(ins.fra)} + ${d0(ins.frb)}), (float)(${d1(ins.fra)} + ${d1(ins.frb)}));`
                );
                break;
            case "ps_sel":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)ppcx_fsel(${d0(ins.fra)}, ${d0(ins.frb)}, ${d0(ins.frc)}), (float)ppcx_fsel(${d1(ins.fra)}, ${d1(ins.frb)}, ${d1(ins.frc)}));`
                );
                break;
            case "ps_mul":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)(${d0(ins.fra)} * ${d0(ins.frc)}), (float)(${d1(ins.fra)} * ${d1(ins.frc)}));`
                );
                break;
            case "ps_msub":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], ppcx_fma_s(${d0(ins.fra)}, ${d0(ins.frc)}, -${d0(ins.frb)}), ppcx_fma_s(${d1(ins.fra)}, ${d1(ins.frc)}, -${d1(ins.frb)}));`
                );
                break;
            case "ps_madd":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], ppcx_fma_s(${d0(ins.fra)}, ${d0(ins.frc)}, ${d0(ins.frb)}), ppcx_fma_s(${d1(ins.fra)}, ${d1(ins.frc)}, ${d1(ins.frb)}));`
                );
                break;
            case "ps_nmsub":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], ppcx_neg_unless_nan_s(ppcx_fma_s(${d0(ins.fra)}, ${d0(ins.frc)}, -${d0(ins.frb)})), ppcx_neg_unless_nan_s(ppcx_fma_s(${d1(ins.fra)}, ${d1(ins.frc)}, -${d1(ins.frb)})));`
                );
                break;
            case "ps_nmadd":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], ppcx_neg_unless_nan_s(ppcx_fma_s(${d0(ins.fra)}, ${d0(ins.frc)}, ${d0(ins.frb)})), ppcx_neg_unless_nan_s(ppcx_fma_s(${d1(ins.fra)}, ${d1(ins.frc)}, ${d1(ins.frb)})));`
                );
                break;
            case "ps_cmpu0":
            case "ps_cmpo0":
                emit(`ppcx_ps_cmp(c, ${ins.crf}, ${d0(ins.fra)}, ${d0(ins.frb)});`);
                break;
            case "ps_cmpu1":
            case "ps_cmpo1":
                emit(`ppcx_ps_cmp(c, ${ins.crf}, ${d1(ins.fra)}, ${d1(ins.frb)});`);
                break;
            case "ps_neg":
                emit(`c->fpr[${ins.frd}].ps0.u = c->fpr[${ins.frb}].ps0.u ^ ${FPR_SIGN};`);
                emit(`c->fpr[${ins.frd}].ps1.u = c->fpr[${ins.frb}].ps1.u ^ ${FPR_SIGN};`);
                break;
            case "ps_abs":
                emit(`c->fpr[${ins.frd}].ps0.u = c->fpr[${ins.frb}].ps0.u & ~${FPR_SIGN};`);
                emit(`c->fpr[${ins.frd}].ps1.u = c->fpr[${ins.frb}].ps1.u & ~${FPR_SIGN};`);
                break;
            case "ps_nabs":
                emit(`c->fpr[${ins.frd}].ps0.u = c->fpr[${ins.frb}].ps0.u | ${FPR_SIGN};`);
                emit(`c->fpr[${ins.frd}].ps1.u = c->fpr[${ins.frb}].ps1.u | ${FPR_SIGN};`);
                break;
            case "ps_mr":
                emit(`c->fpr[${ins.frd}] = c->fpr[${ins.frb}];`);
                break;
            case "ps_res":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)ppcx_res_d(${d0(ins.frb)}), (float)ppcx_res_d(${d1(ins.frb)}));`
                );
                break;
            case "ps_rsqrte":
                emit(
                    `PPCX_SET_PS2(c->fpr[${ins.frd}], (float)ppcx_rsqrte_d(${d0(ins.frb)}), (float)ppcx_rsqrte_d(${d1(ins.frb)}));`
                );
                break;
            case "ps_merge00":
                emit(`PPCX_SET_PS2(c->fpr[${ins.frd}], (float)${d0(ins.fra)}, (float)${d0(ins.frb)});`);
                break;
            case "ps_merge01":
                emit(`PPCX_SET_PS2(c->fpr[${ins.frd}], (float)${d0(ins.fra)}, (float)${d1(ins.frb)});`);
                break;
            case "ps_merge10":
                emit(`PPCX_SET_PS2(c->fpr[${ins.frd}], (float)${d1(ins.fra)}, (float)${d0(ins.frb)});`);
                break;
            case "ps_merge11":
                emit(`PPCX_SET_PS2(c->fpr[${ins.frd}], (float)${d1(ins.fra)}, (float)${d1(ins.frb)});`);
                break;

            default: {
                emit(`PPCX_UNIMPL(c, ${addrHex(ins.addr)}); /* ${ins.name} is not supported yet */`);
                emit("return;");
                lastTransfer = true;
                continue;
            }
        }

        /* CR0 is updated only when the instruction's record bit is set. The
         * XO-form Rc bit and the D-form addic. dot are handled above. */
        if (rcExpr !== null && ins.rc === true) emit(`ppcx_cr0(c, ${rcExpr});`);
    }

    if (!lastTransfer) {
        emit(`PPCX_DISPATCH(c, ${addrHex(end)}); /* fallen through the end of the range */`);
        emit("return;");
    }

    emitRaw("}");

    return {
        name,
        start,
        end,
        code: lines.join("\n"),
        callees: [...callees.values()].sort((a, b) => a.addr - b.addr),
        unsupported: [...unsupported.entries()].map(([n, count]) => ({ name: n, count })),
        warnings,
        hleCalls,
        importAddrs,
        externalTargets: [...externalTargets].sort((a, b) => a - b),
        stats: {
            instructions: instrs.length,
            labels: labels.size,
            needsEa,
        },
    };
}

module.exports = {
    translateFunction,
    hex8,
    fnName,
    labelName,
    branchTarget,
    addrHex,
};
