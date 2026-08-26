import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMinerUResult, type MinerUExtractionResult } from "./python-types.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

export function extractPdfMineruCloud(filepath: string, apiKey: string): Promise<MinerUExtractionResult> {
  const python = process.env.ARGON_MEMORY_PYTHON_BIN || "python3";
  const script = join(directory, "python", "extract_document_mineru.py");
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, filepath], {
      env: { ...process.env, MINERU_API_KEY: apiKey },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let killed = false;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        if (!killed) { killed = true; child.kill("SIGKILL"); }
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    child.on("close", code => {
      if (killed) return reject(new Error("MinerU extractor exceeded the output limit"));
      if (code !== 0) return reject(new Error(`MinerU extractor failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`));
      try {
        resolve(parseMinerUResult(JSON.parse(Buffer.concat(stdout).toString("utf8"))));
      } catch (error) {
        reject(error);
      }
    });
  });
}
