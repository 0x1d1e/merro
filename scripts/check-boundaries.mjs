import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const forbidden = ["node:sqlite", "../store", "../runtime", "../github", "../vcs", "../reconcile"];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

let failed = false;
for (const file of await walk("src/domain")) {
  const source = await readFile(file, "utf8");
  for (const token of forbidden) {
    if (source.includes(token)) {
      console.error(`${file}: domain boundary violation: ${token}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
