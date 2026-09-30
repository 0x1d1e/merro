export interface MerroConfig {
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
