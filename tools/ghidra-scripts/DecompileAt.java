// Decompiles target addresses, creating the function on the fly when the
// auto-analysis missed it. Local analysis helper for BotW-PC research
// (not part of the repository). Keep outputs local.
//
// Usage (headless, writable program):
//   analyzeHeadless <proj> <name> -process <program> -noanalysis \
//     -postScript DecompileAt.java out.c 0xADDR [0xADDR ...]
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

public class DecompileAt extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 2) {
            println("usage: DecompileAt.java out.c 0xADDR [0xADDR ...]");
            return;
        }
        String outName = args[0];
        DecompInterface di = new DecompInterface();
        if (!di.openProgram(currentProgram)) {
            println("decompiler failed to open program: " + di.getLastMessage());
            return;
        }
        FunctionManager fm = currentProgram.getFunctionManager();
        int written = 0;
        try (PrintWriter pw = new PrintWriter(new BufferedWriter(new FileWriter(new File(outName))))) {
            pw.println("// Decompiled from " + currentProgram.getName()
                + " (" + currentProgram.getLanguageID() + ")");
            pw.println("// Local analysis output for BotW-PC research. Do not commit.");
            for (int i = 1; i < args.length; i++) {
                Address addr = toAddr(Long.decode(args[i]));
                Function f = fm.getFunctionAt(addr);
                if (f == null) {
                    disassemble(addr);
                    f = createFunction(addr, null);
                    if (f != null) {
                        println("created function at " + addr);
                    }
                }
                if (f == null) {
                    pw.println();
                    pw.println("// no function at " + addr);
                    continue;
                }
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
                written++;
            }
        }
        di.dispose();
        println("wrote " + written + " target(s) to " + new File(outName).getAbsolutePath());
    }
}
