import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, sep } from "node:path";

export type WorkerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkerRuntimeKind = "pi" | "claude";
export interface WorkerRoleSettings { runtime: WorkerRuntimeKind; model: string | null; thinking: WorkerThinkingLevel | null }
export type WorkerSettings = Record<"implement" | "review", WorkerRoleSettings>;
export type IssueCreatePolicy = "disabled" | "approval" | "auto";
export type MergeMethod = "squash" | "merge" | "rebase";

export interface MerroConfig {
  version: 1;
  projectsDir: string;
  worktreesDir: string;
  workers: { implementer: WorkerRoleSettings; reviewer: WorkerRoleSettings };
  issues: { create: IssueCreatePolicy };
  merge: { auto: boolean; method: MergeMethod; delete_branch: boolean };
  git: { defaultDelivery: "auto" | "local" | "pr" };
  tmux: { session: string };
  max_concurrent_tasks: number | "unlimited";
  max_review_rounds: number | "unlimited";
  sandbox: "docker" | "none";
  network: "on" | "off";
  worker_github: "on" | "off";
  notify_command: string | null;
}

export const DEFAULT_CONFIG: Readonly<MerroConfig> = {
  version: 1,
  projectsDir: "projects",
  worktreesDir: ".wt",
  workers: {
    implementer: { runtime: "pi", model: null, thinking: null },
    reviewer: { runtime: "pi", model: null, thinking: null },
  },
  issues: { create: "approval" },
  merge: { auto: false, method: "squash", delete_branch: true },
  git: { defaultDelivery: "auto" },
  tmux: { session: "merro" },
  max_concurrent_tasks: 3,
  max_review_rounds: 3,
  sandbox: "none",
  network: "on",
  worker_github: "off",
  notify_command: null,
};

export function validateConfig(value: unknown): MerroConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Merro config must be an object");
  }
  const input = value as Record<string, unknown>;
  // Deprecated clone-root settings are read only for persisted-config migration.
  const { work_root: _oldRoot, pi_config: _oldPiConfig, ...current } = input;
  // `worker`, `reviewer`, `worker_models` and `worker_thinking` are migration-only inputs for `workers`.
  const allowed = new Set([...Object.keys(DEFAULT_CONFIG), "worker", "reviewer", "worker_models", "worker_thinking"]);
  const unsupported = Object.keys(current).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`Unsupported Merro setting '${unsupported}'; put instructions in Markdown.`);
  const { worker_models, worker_thinking, ...canonical } = current;
  const { worker: legacyWorker, reviewer: legacyReviewer, ...rest } = canonical;
  const hasRoleMaps = "worker_models" in current || "worker_thinking" in current;
  const hasRoleKeys = "worker" in current || "reviewer" in current;
  if (hasRoleMaps && hasRoleKeys) {
    throw new Error("Cannot combine worker/reviewer with legacy worker_models/worker_thinking; migrate to workers.");
  }
  if ((hasRoleMaps || hasRoleKeys) && "workers" in current) {
    throw new Error("Cannot combine workers with legacy worker, reviewer, worker_models or worker_thinking; use workers only.");
  }
  const merged = { ...DEFAULT_CONFIG, ...rest } as Record<string, unknown>;
  const projectsDir = validateDirectory(merged.projectsDir, "projectsDir");
  const worktreesDir = validateDirectory(merged.worktreesDir, "worktreesDir");
  if (projectsDir === worktreesDir || projectsDir.startsWith(`${worktreesDir}${sep}`) || worktreesDir.startsWith(`${projectsDir}${sep}`)) {
    throw new Error("projectsDir and worktreesDir must not overlap");
  }
  const git = settingsObject(merged.git, "git", ["defaultDelivery"]);
  const defaultDelivery = git.defaultDelivery ?? "auto";
  if (defaultDelivery !== "auto" && defaultDelivery !== "local" && defaultDelivery !== "pr") throw new Error("git.defaultDelivery must be auto, local or pr");
  const tmux = settingsObject(merged.tmux, "tmux", ["session"]);
  const session = tmux.session ?? "merro";
  if (typeof session !== "string" || !/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("tmux.session must be a safe session prefix");

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
  let implementer: unknown;
  let reviewer: unknown;
  if (hasRoleMaps) {
    const models = "worker_models" in current
      ? validateRoleSettings(worker_models, { implement: null, review: null }, "worker_models", (value) => validateModel(value, "worker_models values"))
      : { implement: null, review: null };
    const thinking = "worker_thinking" in current
      ? validateRoleSettings(worker_thinking, { implement: null, review: null }, "worker_thinking", (value) => validateThinking(value, "worker_thinking values"))
      : { implement: null, review: null };
    implementer = { model: models.implement, thinking: thinking.implement };
    reviewer = { model: models.review, thinking: thinking.review };
  } else if (hasRoleKeys) {
    implementer = legacyWorker ?? {};
    reviewer = legacyReviewer ?? {};
  } else {
    const workers = settingsObject(merged.workers, "workers", ["implementer", "reviewer"]);
    implementer = workers.implementer ?? {};
    reviewer = workers.reviewer ?? {};
  }
  const workers = { implementer: validateWorkerSettings(implementer, "workers.implementer"), reviewer: validateWorkerSettings(reviewer, "workers.reviewer") };
  const issues = settingsObject(merged.issues, "issues", ["create"]);
  const create = issues.create ?? "approval";
  if (create !== "disabled" && create !== "approval" && create !== "auto") throw new Error("issues.create must be disabled, approval or auto");
  const merge = settingsObject(merged.merge, "merge", ["auto", "method", "delete_branch"]);
  const auto = merge.auto ?? false;
  const method = merge.method ?? "squash";
  const deleteBranch = merge.delete_branch ?? true;
  if (typeof auto !== "boolean") throw new Error("merge.auto must be a boolean");
  if (method !== "squash" && method !== "merge" && method !== "rebase") throw new Error("merge.method must be squash, merge or rebase");
  if (typeof deleteBranch !== "boolean") throw new Error("merge.delete_branch must be a boolean");
  return {
    ...merged, projectsDir, worktreesDir, workers, issues: { create }, merge: { auto, method, delete_branch: deleteBranch },
    git: { defaultDelivery }, tmux: { session },
  } as unknown as MerroConfig;
}

function validateWorkerSettings(value: unknown, name: string): WorkerRoleSettings {
  const settings = settingsObject(value, name, ["runtime", "model", "thinking"]);
  const runtime = settings.runtime === undefined ? "pi" : settings.runtime;
  if (runtime !== "pi" && runtime !== "claude") throw new Error(`${name}.runtime must be pi or claude`);
  const thinking = validateThinking(settings.thinking === undefined ? null : settings.thinking, `${name}.thinking`);
  if (runtime === "claude" && (thinking === "off" || thinking === "minimal")) {
    throw new Error(`${name}.thinking must be low, medium, high, xhigh or max for the claude runtime`);
  }
  return {
    runtime,
    model: validateModel(settings.model === undefined ? null : settings.model, `${name}.model`),
    thinking,
  };
}

function validateModel(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${name} must be non-empty strings or null`);
  return value.trim();
}

function validateThinking(value: unknown, name: string): WorkerThinkingLevel | null {
  if (value === null) return null;
  if (typeof value !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new Error(`${name} must be a supported thinking level or null`);
  }
  return value as WorkerThinkingLevel;
}

function settingsObject(value: unknown, name: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error(`Unsupported ${name} setting`);
  return input;
}

function validateDirectory(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value) || /[\r\n\0]/.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`${name} must be a workspace-relative directory without traversal`);
  }
  const path = normalize(value.replace(/[\\/]/g, sep));
  if (path === "." || path.split(sep).some((part) => part === ".merro" || part === ".git")) throw new Error(`${name} must not contain workspace state or Git metadata`);
  return path.split(sep).filter(Boolean).join(sep);
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
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return config;
}
