// Part of BotW-PC (MIT License) — https://github.com/Roylizzz/BotW-PC
// Generic Ghidra headless helper; contains no game data.
//
// Tunes auto-analysis options before a headless run. The default options are
// thorough but slow; disabling "Decompiler Parameter ID" speeds up a first
// full pass considerably (parameter recovery can be run later on demand).
//
// Usage:
//   analyzeHeadless <proj-dir> <proj-name> -import <binary> \
//     -scriptPath <repo>/tools/ghidra-scripts \
//     -preScript TuneAnalysis.java -postScript ListSummary.java
//
// Note: analysis option values are strings ("false"), not booleans.
import ghidra.app.script.GhidraScript;

public class TuneAnalysis extends GhidraScript {
    @Override
    public void run() throws Exception {
        try {
            setAnalysisOption(currentProgram, "Decompiler Parameter ID", "false");
            println("TuneAnalysis: disabled 'Decompiler Parameter ID'");
        } catch (Exception e) {
            println("TuneAnalysis: could not disable 'Decompiler Parameter ID': " + e.getMessage());
        }
        try {
            setAnalysisOption(currentProgram, "Windows x86 PE RTTI Analyzer", "false");
            println("TuneAnalysis: disabled 'Windows x86 PE RTTI Analyzer'");
        } catch (Exception e) {
            // not an error on non-PE programs; ignore
        }
    }
}
