// Part of BotW-PC (MIT License) — https://github.com/Roylizzz/BotW-PC
// Generic Ghidra headless helper; contains no game data.
//
// Decompiles functions whose name matches a substring (case-insensitive) or
// a single 0x-address, writing C source to a local file. Keep outputs local:
// decompiled game code must never be committed to the repository.
//
// Usage:
//   analyzeHeadless <proj-dir> <proj-name> -process <program> \
//     -scriptPath <repo>/tools/ghidra-scripts \
//     -postScript DecompileMatch.java FUN_02001234 out.c [--max 25]
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;

public class DecompileMatch extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            println("usage: DecompileMatch.java <name-substring | 0xADDRESS> [outFile] [--max N]");
            return;
        }
        String pattern = args[0];
        int max = 25;
        String outName = null;
        for (int i = 1; i < args.length; i++) {
            if ("--max".equals(args[i]) && i + 1 < args.length) {
                max = Integer.parseInt(args[++i]);
            } else if (outName == null) {
                outName = args[i];
            }
        }

        List<Function> matches = new ArrayList<>();
        FunctionManager fm = currentProgram.getFunctionManager();
        if (pattern.startsWith("0x")) {
            Address addr = currentProgram.getAddressFactory().getAddress(pattern);
            Function f = fm.getFunctionAt(addr);
            if (f == null) {
                f = fm.getFunctionContaining(addr);
            }
            if (f != null) {
                matches.add(f);
            }
        } else {
            String needle = pattern.toLowerCase();
            for (Function f : fm.getFunctions(true)) {
                if (f.getName().toLowerCase().contains(needle)) {
                    matches.add(f);
                    if (matches.size() >= max) {
                        break;
                    }
                }
            }
        }
        if (matches.isEmpty()) {
            println("no function matched '" + pattern + "'");
            return;
        }

        File out = new File(outName != null
            ? outName
            : "decomp-" + pattern.replaceAll("[^A-Za-z0-9_.-]", "_") + ".c");

        DecompInterface di = new DecompInterface();
        if (!di.openProgram(currentProgram)) {
            println("decompiler failed to open program: " + di.getLastMessage());
            return;
        }
        try (PrintWriter pw = new PrintWriter(new BufferedWriter(new FileWriter(out)))) {
            pw.println("// Decompiled from " + currentProgram.getName()
                + " (" + currentProgram.getLanguageID() + ")");
            pw.println("// Local analysis output for BotW-PC research. Do not commit.");
            for (Function f : matches) {
                pw.println();
                pw.println("//===== " + f.getName() + " @ " + f.getEntryPoint()
                    + " (size " + f.getBody().getNumAddresses() + ") =====");
                DecompileResults res = di.decompileFunction(f, 120, monitor);
                if (res != null && res.decompileCompleted() && res.getDecompiledFunction() != null) {
                    pw.println(res.getDecompiledFunction().getC());
                } else {
                    pw.println("// decompilation failed: "
                        + (res == null ? "no result" : res.getErrorMessage()));
                }
            }
        }
        di.dispose();
        println("wrote " + matches.size() + " function(s) to " + out.getAbsolutePath());
    }
}
