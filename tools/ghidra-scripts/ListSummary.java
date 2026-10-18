// Part of BotW-PC (MIT License) — https://github.com/Roylizzz/BotW-PC
// Generic Ghidra headless helper; contains no game data.
//
// Prints the current program's language, memory blocks and function count.
// Usage:
//   analyzeHeadless <proj-dir> <proj-name> -process <program> \
//     -scriptPath <repo>/tools/ghidra-scripts -postScript ListSummary.java
import ghidra.app.script.GhidraScript;
import ghidra.program.model.mem.MemoryBlock;

public class ListSummary extends GhidraScript {
    @Override
    public void run() throws Exception {
        println("language   : " + currentProgram.getLanguage().getLanguageID());
        println("compiler   : " + currentProgram.getCompilerSpec().getCompilerSpecID());
        println("imageBase  : " + currentProgram.getImageBase());
        println("== memory blocks ==");
        long total = 0;
        for (MemoryBlock b : currentProgram.getMemory().getBlocks()) {
            println(String.format("%-16s %08x - %08x  size=%9d  r=%s w=%s x=%s init=%s",
                b.getName(),
                b.getStart().getOffset(),
                b.getEnd().getOffset(),
                b.getSize(),
                b.isRead(), b.isWrite(), b.isExecute(), b.isInitialized()));
            if (b.isInitialized()) {
                total += b.getSize();
            }
        }
        println("total initialized bytes: " + total);
        int n = 0;
        for (Object ignored : currentProgram.getFunctionManager().getFunctions(true)) {
            n++;
        }
        println("functions: " + n);
    }
}
