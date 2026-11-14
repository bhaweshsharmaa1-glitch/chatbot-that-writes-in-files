import { mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const sourcePath = fileURLToPath(new URL("./file_writer.c", import.meta.url));
const outputPath = fileURLToPath(new URL(
  process.platform === "win32" ? "./.build/file_writer.exe" : "./.build/file_writer",
  import.meta.url
));

await mkdir(dirname(outputPath), { recursive: true });
await rm(outputPath, { force: true });

try {
  const compilerCandidates = [
    process.env.CLANG || "clang",
    "C:\\Program Files\\LLVM\\bin\\clang.exe"
  ];
  let lastError;
  for (const compiler of compilerCandidates) {
    try {
      await execFileAsync(compiler, ["-std=c17", "-O2", "-Wall", "-Wextra", sourcePath, "-o", outputPath], {
        windowsHide: true
      });
      console.log("Built the native C file writer.");
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
} catch (error) {
  console.warn(`Native C file writer unavailable; using the Node fallback. ${error.message}`);
}