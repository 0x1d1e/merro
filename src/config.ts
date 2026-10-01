import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface MerroConfig {
  version: 1;
  max_concurrent_tasks: number | "unlimited";
  max_review_rounds: number | "unlimited";
  pi_config: "copy" | "clean";
  sandbox: "docker" | "none";
  network: "on" | "off";
  worker_github: "on" | "off";
  work_root: string | null;
  notify_command: string | null;
}

export const DEFAULT_CONFIG: Readonly<MerroConfig> = {
  version: 1,
  max_concurrent_tasks: 3,
  max_review_rounds: 3,
  pi_config: "copy",
  sandbox: "docker",
  network: "on",
  worker_github: "on",
  work_root: null,
  notify_command: null,
};

export function validateConfig(value: unknown): MerroConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Merro config must be an object");
  }
  const input = value as Record<string, unknown>;
  const merged = { ...DEFAULT_CONFIG, ...input } as Record<string, unknown>;

  if (merged.version !== 1) throw new Error(`unsupported Merro config version: ${String(merged.version)}`);
  const concurrency = merged.max_concurrent_tasks;
  if (concurrency !== "unlimited" && (!Number.isInteger(concurrency) || Number(concurrency) < 1)) {
    throw new Error("max_concurrent_tasks must be a positive integer or unlimited");
  }
  const rounds = merged.max_review_rounds;
  if (rounds !== "unlimited" && (!Number.isInteger(rounds) || Number(rounds) < 1)) {
    throw new Error("max_review_rounds must be a positive integer or unlimited");
  }
  if (merged.pi_config !== "copy" && merged.pi_config !== "clean") throw new Error("pi_config must be copy or clean");
  if (merged.sandbox !== "docker" && merged.sandbox !== "none") throw new Error("sandbox must be docker or none");
  if (merged.network !== "on" && merged.network !== "off") throw new Error("network must be on or off");
  if (merged.worker_github !== "on" && merged.worker_github !== "off") throw new Error("worker_github must be on or off");
  if (merged.work_root !== null && typeof merged.work_root !== "string") throw new Error("work_root must be a string or null");
  if (merged.notify_command !== null && typeof merged.notify_command !== "string") throw new Error("notify_command must be a string or null");

  return merged as unknown as MerroConfig;
}

export async function loadConfig(path: string): Promise<MerroConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return saveConfig(path, DEFAULT_CONFIG);
  }
  return validateConfig(JSON.parse(text) as unknown);
}

export async function saveConfig(path: string, value: unknown): Promise<MerroConfig> {
  const config = validateConfig(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return config;
}
