import { cpSync, chmodSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
const sourceOnly = path => basename(path) !== "__pycache__" && !/\.py[cod]$/.test(path);
for (const directory of ["backends", "normalization"]) {
  const output = `dist/${directory}/python`;
  cpSync(`src/${directory}/python`, output, { recursive: true, filter: sourceOnly });
  const removeCaches = path => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (!sourceOnly(child)) rmSync(child, { recursive: true, force: true });
      else if (item.isDirectory()) removeCaches(child);
    }
  };
  removeCaches(output);
}
chmodSync("dist/cli.js", 0o755);
