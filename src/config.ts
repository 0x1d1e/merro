import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type WorkerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkerSettings = Record<"implement" | "review", { model: string | null; thinking: WorkerThinkingLevel | null }>;

export interface MerroConfig {
  version: 1;
  max_concurrent_tasks: number | "unlimited";
  max_review_rounds: number | "unlimited";
  sandbox: "docker" | "none";
  network: "on" | "off";
  worker_github: "on" | "off";
  worker_models: Record<"implement" | "review", string | null>;
  worker_thinking: Record<"implement" | "review", WorkerThinkingLevel | null>;
  notify_command: string | null;
}

export const DEFAULT_CONFIG: Readonly<MerroConfig> = {
  version: 1,
  max_concurrent_tasks: 3,
  max_review_rounds: 3,
  sandbox: "none",
  network: "on",
  worker_github: "on",
  worker_models: { implement: null, review: null },
  worker_thinking: { implement: null, review: null },
  notify_command: null,
};

export function validateConfig(value: unknown): MerroConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Merro config must be an object");
  }
  const input = value as Record<string, unknown>;
  // Deprecated clone-root settings are read only for persisted-config migration.
  const { work_root: _oldRoot, pi_config: _oldPiConfig, ...current } = input;
  const merged = { ...DEFAULT_CONFIG, ...current } as Record<string, unknown>;

  if (merged.version !== 1) throw new Error(`unsupported Merro config version: ${String(merged.version)}`);
  const concurrency = merged.max_concurrent_tasks;
  if (concurrency !== "unlimited" && (!Number.isInteger(concurrency) || Number(concurrency) < 1)) {
    throw new Error("max_concurrent_tasks must be a positive integer or unlimited");
  }
  const rounds = merged.max_review_rounds;
  if (rounds !== "unlimited" && (!Number.isInteger(rounds) || Number(rounds) < 1)) {
    throw new Error("max_review_rounds must be a positive integer or unlimited");
  }
  if (merged.sandbox !== "docker" && merged.sandbox !== "none") throw new Error("sandbox must be docker or none");
  if (merged.network !== "on" && merged.network !== "off") throw new Error("network must be on or off");
  if (merged.worker_github !== "on" && merged.worker_github !== "off") throw new Error("worker_github must be on or off");
  if (merged.notify_command !== null && typeof merged.notify_command !== "string") throw new Error("notify_command must be a string or null");
  const workerModels = validateRoleSettings(merged.worker_models, DEFAULT_CONFIG.worker_models, "worker_models", (value) => {
    if (value === null) return null;
    if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error("worker_models values must be non-empty strings or null");
    return value.trim();
  });
  const workerThinking = validateRoleSettings(merged.worker_thinking, DEFAULT_CONFIG.worker_thinking, "worker_thinking", (value) => {
    if (value === null) return null;
    if (typeof value !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
      throw new Error("worker_thinking values must be a Pi thinking level or null");
    }
    return value as WorkerThinkingLevel;
  });

  return { ...merged, worker_models: workerModels, worker_thinking: workerThinking } as unknown as MerroConfig;
}

function validateRoleSettings<T>(
  value: unknown,
  defaults: Record<"implement" | "review", T>,
  name: string,
  parse: (value: unknown) => T,
): Record<"implement" | "review", T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const input = value as Record<string, unknown>;
  const unknownRole = Object.keys(input).find((role) => role !== "implement" && role !== "review");
  if (unknownRole) throw new Error(`${name} has unsupported role '${unknownRole}'`);
  return {
    implement: input.implement === undefined ? defaults.implement : parse(input.implement),
    review: input.review === undefined ? defaults.review : parse(input.review),
  };
}

export async function loadConfig(path: string): Promise<MerroConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("Merro workspace config is missing. Run /merro init.");
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
