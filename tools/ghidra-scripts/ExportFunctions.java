// Part of BotW-PC (MIT License) — https://github.com/Roylizzz/BotW-PC
// Generic Ghidra headless helper; contains no game data.
//
// Exports a function inventory as CSV (address, name, size, flags).
// Usage:
//   analyzeHeadless <proj-dir> <proj-name> -process <program> \
//     -scriptPath <repo>/tools/ghidra-scripts -postScript ExportFunctions.java out.csv
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;

public class ExportFunctions extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        File out = new File(args.length > 0 ? args[0] : "functions.csv");
        FunctionManager fm = currentProgram.getFunctionManager();
        int n = 0;
        try (PrintWriter pw = new PrintWriter(new BufferedWriter(new FileWriter(out)))) {
            pw.println("address,name,size,thunk,external");
            for (Function f : fm.getFunctions(true)) {
                pw.println(String.format("0x%08x,%s,%d,%s,%s",
                    f.getEntryPoint().getOffset(),
                    f.getName(),
                    f.getBody().getNumAddresses(),
                    f.isThunk(),
                    f.isExternal()));
                n++;
            }
        }
        println("wrote " + n + " functions to " + out.getAbsolutePath());
    }
}
