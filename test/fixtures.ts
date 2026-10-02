import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { MerroStore } from "../src/store/store.js";

/** Seed persisted state for tests whose subject is reconciliation, not initialization. */
export async function initializedState(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".merro", "runtime"), { recursive: true });
  await writeFile(join(cwd, ".merro", "config.json"), JSON.stringify(DEFAULT_CONFIG));
  new MerroStore(join(cwd, ".merro", "state.db")).close();
}
