import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { Project, TaskRole } from "../domain/model.js";
import type { MerroConfig } from "../config.js";
import type { ProjectSettingsRecord, TaskRuntimeRecord } from "../store/model.js";
import { systemCommandRunner, type CommandRunner } from "./commands.js";

const GENERIC_IMAGE = "merro-worker:0.1.0";
const TASK_MOUNT = "/merro-task";
const CLONE_MOUNT = "/work";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = findPackageRoot(moduleDirectory);
const require = createRequire(import.meta.url);

function findPackageRoot(start: string): string {
  let directory = resolve(start);
  while (true) {
    if (existsSync(join(directory, "package.json")) && existsSync(join(directory, "src"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`cannot locate Merro package root from ${start}`);
    directory = parent;
  }
}

function projectOwner(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath)).digest("hex");
}

export interface WorkerDependencyMount {
  projectSlug: string;
  checkoutPath: string;
  mountPath: string;
}

export interface WorkerLaunchInput {
  taskId: string;
  workItemId: string;
  role: TaskRole;
  project: Project;
  clonePath: string;
  taskFile: string;
  expectedCommit: string;
  projectSettings: ProjectSettingsRecord | null;
  dependencies?: readonly WorkerDependencyMount[];
}

export interface WorkerPresence {
  alive: boolean;
  identityMatches: boolean;
  reason: string | null;
}

export interface WorkerRuntimeOptions {
  workspacePath: string;
  config: MerroConfig;
  commands?: CommandRunner;
  piConfigPath?: string;
}

function safeName(value: string): string {
  const name = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!name) throw new Error("Task and Project identities must contain a safe tmux name");
  return name;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function projectSession(project: Project): string {
  return `merro-${safeName(project.slug)}`;
}

function taskWindow(input: WorkerLaunchInput): string {
  return `${input.role === "implement" ? "impl" : "rev"}-${safeName(input.taskId)}`;
}

function timestampFromEpoch(value: string): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function parseDockerInspect(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("docker inspect returned invalid JSON", { cause: error });
  }
  if (!Array.isArray(value) || typeof value[0] !== "object" || value[0] === null) {
    throw new Error("docker inspect returned an unexpected value");
  }
  return value[0] as Record<string, unknown>;
}

function shellScript(environment: Record<string, string>, command: string): string {
  const exports = Object.entries(environment).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
  return `#!/bin/sh\nset -eu\nrm -- "$0"\nunset GH_TOKEN GITHUB_TOKEN\n${exports}\nexec ${command}\n`;
}

async function copyTree(source: string, target: string, omitted = new Set<string>()): Promise<void> {
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (omitted.has(entry.name) || entry.isSymbolicLink()) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to, omitted);
      await chmod(to, 0o700);
    } else if (entry.isFile()) {
      await copyFile(from, to);
      await chmod(to, 0o600);
    }
  }
}

async function taskExcludeFile(clonePath: string): Promise<void> {
  const excludePath = join(clonePath, ".git", "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch (error) {
    if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!current.split(/\r?\n/).includes("/.merro-task.md")) {
    await writeFile(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}/.merro-task.md\n`, "utf8");
  }
}

export class WorkerRuntime {
  readonly #workspacePath: string;
  readonly #config: MerroConfig;
  readonly #commands: CommandRunner;
  readonly #piConfigPath: string;
  readonly #resolvedImages = new Map<string, string>();

  constructor(options: WorkerRuntimeOptions) {
    this.#workspacePath = resolve(options.workspacePath);
    this.#config = options.config;
    this.#commands = options.commands ?? systemCommandRunner;
    this.#piConfigPath = options.piConfigPath ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  }

  async prepareClone(project: Project, clonePath: string, settings: ProjectSettingsRecord | null): Promise<void> {
    const sandbox = settings?.sandbox ?? this.#config.sandbox;
    const network = settings?.network ?? this.#config.network;
    if (sandbox === "none" && network === "off") throw new Error("network=off requires Docker sandboxing");
    if (!settings?.setupCommand?.trim()) return;
    if (sandbox === "none") {
      await this.#commands.run("bash", ["-lc", settings.setupCommand], { cwd: clonePath });
      return;
    }
    const image = await this.#resolveImage(project, settings);
    const args = ["run", "--rm", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--env", "HOME=/tmp", "--workdir", CLONE_MOUNT, "--volume", `${resolve(clonePath)}:${CLONE_MOUNT}`];
    if (network === "off") args.push("--network", "none");
    args.push(image, "sh", "-lc", settings.setupCommand);
    await this.#commands.run("docker", args);
  }

  plan(input: WorkerLaunchInput): TaskRuntimeRecord {
    const sandbox = input.projectSettings?.sandbox ?? this.#config.sandbox;
    const network = input.projectSettings?.network ?? this.#config.network;
    if (sandbox === "none" && network === "off") {
      throw new Error("network=off requires Docker sandboxing");
    }
    const scratchPath = join(this.#workspacePath, "tasks", safeName(input.taskId));
    return {
      taskId: input.taskId,
      runtimeKind: sandbox === "docker" ? "docker" : "host",
      tmuxSession: projectSession(input.project),
      tmuxWindow: taskWindow(input),
      paneId: null,
      containerId: null,
      processPid: null,
      processStartedAt: null,
      clonePath: resolve(input.clonePath),
      taskFilePath: join(resolve(input.clonePath), ".merro-task.md"),
      resultPath: join(scratchPath, ".merro-result.json"),
      expectedCommit: input.expectedCommit,
      startedAt: new Date().toISOString(),
    };
  }

  async launch(input: WorkerLaunchInput, plan = this.plan(input)): Promise<TaskRuntimeRecord> {
    const sandbox = input.projectSettings?.sandbox ?? this.#config.sandbox;
    const network = input.projectSettings?.network ?? this.#config.network;
    const startedAt = plan.startedAt;
    const scratchPath = dirname(plan.resultPath);
    const secretRoot = join(this.#workspacePath, "launch-secrets");
    const scratchConfigPath = join(scratchPath, "pi-config");
    const extensionRoot = join(scratchPath, "merro-runtime");
    const homePath = join(scratchPath, "home");
    const resultPath = plan.resultPath;
    const taskFilePath = plan.taskFilePath;
    const session = plan.tmuxSession;
    const window = plan.tmuxWindow;

    await mkdir(scratchPath, { recursive: true, mode: 0o700 });
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    await taskExcludeFile(input.clonePath);
    await writeFile(taskFilePath, input.taskFile, { encoding: "utf8", mode: 0o600 });
    await this.#copyPiConfig(scratchConfigPath);
    await this.#copyWorkerExtension(extensionRoot);
    await this.#ensureSession(session, input.project);

    const environment: Record<string, string> = {
      HOME: join(TASK_MOUNT, "home"),
      PI_CODING_AGENT_DIR: join(TASK_MOUNT, "pi-config"),
      MERRO_TASK_ID: input.taskId,
      MERRO_TASK_ROLE: input.role,
      MERRO_RESULT_PATH: join(TASK_MOUNT, ".merro-result.json"),
    };
    const workerGithub = input.projectSettings?.workerGithub ?? this.#config.worker_github === "on";
    if (workerGithub) {
      const token = (await this.#commands.run("gh", ["auth", "token"], { cwd: input.project.path })).stdout.trim();
      if (!token || /[\r\n]/.test(token)) throw new Error("gh auth token returned an invalid worker token");
      environment.GH_TOKEN = token;
    }

    const piArgs = [
      "pi", "--no-session", "--print", "--extension",
      join(TASK_MOUNT, "merro-runtime", "tools", "worker-result.js"),
      "--", `@${CLONE_MOUNT}/.merro-task.md`,
    ];
    const cidPath = join(this.#workspacePath, "container-ids", `${safeName(input.taskId)}.cid`);
    let paneId: string | null = null;
    let containerId: string | null = null;
    let processPid: number | null = null;
    let processStartedAt: string | null = null;
    let launchCommand: string;
    let launchSecretPath: string | null = null;
    let launchSucceeded = false;
    let windowLaunchAttempted = false;

    try {
      if (sandbox === "docker") {
        const image = await this.#resolveImage(input.project, input.projectSettings);
        await mkdir(dirname(cidPath), { recursive: true, mode: 0o700 });
        await rm(cidPath, { force: true });
        const environmentPath = join(secretRoot, `${safeName(input.taskId)}.env`);
        launchSecretPath = environmentPath;
        await mkdir(secretRoot, { recursive: true, mode: 0o700 });
        await writeFile(environmentPath, `${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
        const dependencyVolumes = (input.dependencies ?? []).flatMap((dependency) => {
          const checkoutPath = resolve(dependency.checkoutPath);
          const checkoutRelative = relative(scratchPath, checkoutPath);
          if (!checkoutRelative || checkoutRelative === ".." || checkoutRelative.startsWith(`..${sep}`) || isAbsolute(checkoutRelative)) {
            throw new Error(`dependency checkout must be inside Task scratch: ${checkoutPath}`);
          }
          if (!/^\/merro-dependencies\/[1-9][0-9]*$/.test(dependency.mountPath)) {
            throw new Error(`invalid dependency mount path: ${dependency.mountPath}`);
          }
          return ["--volume", `${checkoutPath}:${dependency.mountPath}:ro`];
        });
        const dockerArgs = [
          "run", "--rm", "--cidfile", cidPath,
          "--name", `merro-${safeName(input.taskId)}`,
          "--label", `merro.task_id=${input.taskId}`,
          "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          "--workdir", CLONE_MOUNT,
          "--volume", `${resolve(input.clonePath)}:${CLONE_MOUNT}${input.role === "review" ? ":ro" : ""}`,
          "--volume", `${scratchPath}:${TASK_MOUNT}`,
          ...dependencyVolumes,
          "--network", network === "off" ? "none" : "bridge",
          "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=1g",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          "--pids-limit", "256", "--env-file", environmentPath,
          image,
          ...piArgs,
        ];
        launchCommand = ["docker", ...dockerArgs].map(shellQuote).join(" ");
      } else {
        const hostEnvironment = {
          ...environment,
          HOME: homePath,
          PI_CODING_AGENT_DIR: scratchConfigPath,
          MERRO_RESULT_PATH: resultPath,
        };
        const hostArgs = [
          "pi", "--no-session", "--print", "--extension",
          join(extensionRoot, "tools", "worker-result.js"),
          "--", `@${taskFilePath}`,
        ];
        const command = hostArgs.map(shellQuote).join(" ");
        const scriptPath = join(secretRoot, `${safeName(input.taskId)}.sh`);
        launchSecretPath = scriptPath;
        await mkdir(secretRoot, { recursive: true, mode: 0o700 });
        await writeFile(scriptPath, shellScript(hostEnvironment, command), { encoding: "utf8", mode: 0o700 });
        await chmod(scriptPath, 0o700);
        launchCommand = shellQuote(scriptPath);
      }

      windowLaunchAttempted = true;
      const paneResult = await this.#commands.run("tmux", [
        "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", session,
        "-n", window, "-c", sandbox === "none" ? resolve(input.clonePath) : input.project.path,
        launchCommand,
      ]);
      paneId = paneResult.stdout.trim() || null;
      if (!paneId) throw new Error(`tmux did not return a pane ID for Task ${input.taskId}`);

      if (sandbox === "docker") {
        containerId = await this.#waitForContainerId(cidPath);
        try {
          const inspect = parseDockerInspect((await this.#commands.run("docker", ["inspect", containerId])).stdout);
          const state = typeof inspect.State === "object" && inspect.State !== null
            ? inspect.State as Record<string, unknown>
            : {};
          processPid = 1;
          processStartedAt = typeof state.StartedAt === "string" ? state.StartedAt : startedAt;
        } catch {
          processPid = 1;
          processStartedAt = startedAt;
        }
      } else {
        const pane = (await this.#commands.run("tmux", ["display-message", "-p", "-t", paneId, "#{pane_pid} #{pane_start_time}"])).stdout.trim().split(/\s+/);
        processPid = Number(pane[0]);
        processStartedAt = timestampFromEpoch(pane[1] ?? "") ?? startedAt;
        if (!Number.isSafeInteger(processPid) || processPid < 1) processPid = null;
      }

      launchSucceeded = true;
      return {
        taskId: input.taskId,
        runtimeKind: sandbox === "docker" ? "docker" : "host",
        tmuxSession: session,
        tmuxWindow: window,
        paneId,
        containerId,
        processPid,
        processStartedAt,
        clonePath: resolve(input.clonePath),
        taskFilePath,
        resultPath,
        expectedCommit: input.expectedCommit,
        startedAt,
      };
    } catch (error) {
      const partial = { ...plan, paneId, containerId, processPid, processStartedAt };
      try {
        if (windowLaunchAttempted) {
          const target = paneId ?? `${session}:${window}`;
          await this.#commands.run("tmux", ["kill-window", "-t", target]).catch(async (killError: unknown) => {
            const exists = await this.#commands.run("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"])
              .then(() => true, () => false);
            if (exists) throw killError;
          });
        }
        await this.stop(partial, input.taskId);
        await this.cleanup(partial);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Worker launch failed and rollback failed: ${String(error)}; ${String(rollbackError)}`);
      }
      throw error;
    } finally {
      if (launchSecretPath !== null && (!launchSucceeded || sandbox === "docker")) {
        await rm(launchSecretPath, { force: true });
      }
    }
  }

  async inspect(record: TaskRuntimeRecord, taskId: string): Promise<WorkerPresence> {
    const runtimeKind = record.runtimeKind ?? (record.containerId || this.#config.sandbox === "docker" ? "docker" : "host");
    if (runtimeKind === "docker") {
      const container = record.containerId ?? `merro-${safeName(taskId)}`;
      let inspect: Record<string, unknown>;
      try {
        inspect = parseDockerInspect((await this.#commands.run("docker", ["inspect", container])).stdout);
      } catch (error) {
        return { alive: false, identityMatches: false, reason: `Docker container is gone: ${String(error)}` };
      }
      const state = typeof inspect.State === "object" && inspect.State !== null
        ? inspect.State as Record<string, unknown>
        : {};
      const config = typeof inspect.Config === "object" && inspect.Config !== null
        ? inspect.Config as Record<string, unknown>
        : {};
      const labels = typeof config.Labels === "object" && config.Labels !== null
        ? config.Labels as Record<string, unknown>
        : {};
      const actualId = typeof inspect.Id === "string" ? inspect.Id : null;
      const alive = state.Running === true;
      const identityMatches = actualId !== null && (!record.containerId || actualId === record.containerId)
        && labels["merro.task_id"] === taskId;
      if (!alive) return { alive: false, identityMatches, reason: "Docker container is not running" };
      if (!identityMatches) return { alive: true, identityMatches: false, reason: "Docker container identity does not match the active Task" };
      try {
        const output = await this.#commands.run("docker", ["exec", actualId, "sh", "-lc", "tr '\\0' ' ' </proc/1/cmdline"]);
        if (!output.stdout.includes("pi")) return { alive: true, identityMatches: false, reason: "container PID 1 is not the expected Pi process" };
      } catch (error) {
        return { alive: true, identityMatches: false, reason: `cannot verify Pi process identity: ${String(error)}` };
      }
      return { alive: true, identityMatches: true, reason: null };
    }

    try {
      const result = (await this.#commands.run("tmux", [
        "display-message", "-p", "-t", `${record.tmuxSession}:${record.tmuxWindow}`,
        "#{pane_id} #{pane_pid} #{pane_start_time} #{pane_current_command}",
      ])).stdout.trim().split(/\s+/);
      const startedAt = timestampFromEpoch(result[2] ?? "");
      const hasProcessIdentity = record.paneId !== null || record.processPid !== null;
      const taskWindowMatches = hasProcessIdentity || record.tmuxWindow.endsWith(safeName(taskId));
      const identityMatches = taskWindowMatches
        && (record.paneId === null || result[0] === record.paneId)
        && (record.processPid === null || Number(result[1]) === record.processPid)
        && (record.processStartedAt === null || startedAt === record.processStartedAt)
        && (hasProcessIdentity || result[3] === "pi" || result[3] === "node");
      return identityMatches
        ? { alive: true, identityMatches: true, reason: null }
        : { alive: true, identityMatches: false, reason: `tmux pane identity changed for Task ${taskId}` };
    } catch (error) {
      return { alive: false, identityMatches: false, reason: `tmux pane is gone: ${String(error)}` };
    }
  }

  async stop(record: TaskRuntimeRecord, taskId: string): Promise<void> {
    const presence = await this.inspect(record, taskId);
    if (!presence.alive) return;
    if (!presence.identityMatches) {
      throw new Error(`refusing to stop a worker whose identity does not match Task ${taskId}`);
    }
    const runtimeKind = record.runtimeKind ?? (record.containerId || this.#config.sandbox === "docker" ? "docker" : "host");
    if (runtimeKind === "docker") {
      const container = record.containerId ?? `merro-${safeName(taskId)}`;
      await this.#commands.run("docker", ["stop", "--time", "10", container]);
      return;
    }
    await this.#commands.run("tmux", ["kill-window", "-t", `${record.tmuxSession}:${record.tmuxWindow}`]);
  }

  async cleanup(record: TaskRuntimeRecord, options: { preserveResult?: boolean; preserveTaskInput?: boolean } = {}): Promise<void> {
    const scratch = dirname(record.resultPath);
    await this.#makeWritable(scratch);
    if (options.preserveResult) {
      const entries = await readdir(scratch).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (join(scratch, entry) !== record.resultPath) await rm(join(scratch, entry), { recursive: true, force: true });
      }
    } else {
      await rm(scratch, { recursive: true, force: true });
    }
    // Main preserves the shared input while a successor Task owns this clone.
    if (!options.preserveTaskInput) await rm(record.taskFilePath, { force: true });
    const name = safeName(record.taskId);
    await rm(join(this.#workspacePath, "container-ids", `${name}.cid`), { force: true });
    await rm(join(this.#workspacePath, "launch-secrets", `${name}.env`), { force: true });
    await rm(join(this.#workspacePath, "launch-secrets", `${name}.sh`), { force: true });
  }

  async #makeWritable(path: string): Promise<void> {
    let details;
    try {
      details = await lstat(path);
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (details.isSymbolicLink()) return;
    if (details.isDirectory()) {
      for (const entry of await readdir(path)) await this.#makeWritable(join(path, entry));
      await chmod(path, details.mode | 0o700);
    } else if (details.isFile()) {
      await chmod(path, details.mode | 0o600);
    }
  }

  async #copyPiConfig(target: string): Promise<void> {
    await mkdir(target, { recursive: true, mode: 0o700 });
    if (this.#config.pi_config === "clean") {
      await copyFile(join(this.#piConfigPath, "auth.json"), join(target, "auth.json")).catch((error: unknown) => {
        if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      return;
    }
    await copyTree(this.#piConfigPath, target, new Set(["sessions", "logs", "cache", "tmp"]));
    await chmod(target, 0o700);
  }

  async #copyWorkerExtension(target: string): Promise<void> {
    const tools = join(target, "tools");
    const protocol = join(target, "protocol");
    const compiledSource = join(packageRoot, "dist", "src");
    await mkdir(tools, { recursive: true, mode: 0o700 });
    await mkdir(protocol, { recursive: true, mode: 0o700 });
    const workerExtension = join(compiledSource, "tools", "worker-result.js");
    const resultProtocol = join(compiledSource, "protocol", "result.js");
    if (!existsSync(workerExtension) || !existsSync(resultProtocol)) {
      throw new Error("compiled worker extension is missing; run npm run build before launching Tasks");
    }
    await copyFile(workerExtension, join(tools, "worker-result.js"));
    await copyFile(resultProtocol, join(protocol, "result.js"));
    await writeFile(join(target, "package.json"), '{"type":"module"}\n', { encoding: "utf8", mode: 0o600 });
    const typeboxEntry = require.resolve("typebox");
    const typeboxRoot = resolve(dirname(typeboxEntry), "..");
    await copyTree(typeboxRoot, join(target, "node_modules", "typebox"));
  }

  async #ensureSession(session: string, project: Project): Promise<void> {
    const owner = projectOwner(project.path);
    try {
      await this.#commands.run("tmux", ["has-session", "-t", session]);
    } catch {
      await this.#commands.run("tmux", ["new-session", "-d", "-s", session, "-n", "main", "-c", project.path]);
      await this.#commands.run("tmux", ["set-option", "-t", session, "@merro_project", project.slug]);
      await this.#commands.run("tmux", ["set-option", "-t", session, "@merro_owner", owner]);
      await this.#commands.run("tmux", ["set-environment", "-t", session, "MERRO_PROJECT", project.slug]);
      await this.#commands.run("tmux", ["set-environment", "-t", session, "MERRO_OWNER", owner]);
      return;
    }

    const [storedProject, storedOwner] = await Promise.all([
      this.#commands.run("tmux", ["show-option", "-qv", "-t", session, "@merro_project"]),
      this.#commands.run("tmux", ["show-option", "-qv", "-t", session, "@merro_owner"]),
    ]);
    if (storedProject.stdout.trim() !== project.slug || storedOwner.stdout.trim() !== owner) {
      throw new Error(`refusing to adopt unowned tmux session ${session}`);
    }
  }

  async #waitForContainerId(path: string): Promise<string> {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      try {
        const id = (await readFile(path, "utf8")).trim();
        if (/^[0-9a-f]{12,64}$/i.test(id)) return id;
      } catch (error) {
        if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Docker did not start a container (missing cidfile ${path})`);
  }

  async #resolveImage(project: Project, settings: ProjectSettingsRecord | null): Promise<string> {
    const configured = settings?.image?.trim();
    if (configured) {
      const localDockerfile = isAbsolute(configured) ? configured : resolve(project.path, configured);
      try {
        const details = await stat(localDockerfile);
        if (details.isFile()) {
          const tag = `merro-${safeName(project.slug).toLowerCase()}:${Buffer.from(localDockerfile).toString("hex").slice(0, 12)}`;
          const cached = this.#resolvedImages.get(localDockerfile);
          if (cached) return cached;
          await this.#commands.run("docker", ["build", "--tag", tag, "--file", localDockerfile, project.path]);
          this.#resolvedImages.set(localDockerfile, tag);
          return tag;
        }
      } catch (error) {
        if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.#commands.run("docker", ["image", "inspect", configured]);
      return configured;
    }

    const cached = this.#resolvedImages.get(GENERIC_IMAGE);
    if (cached) return cached;
    try {
      await this.#commands.run("docker", ["image", "inspect", GENERIC_IMAGE]);
    } catch {
      const piVersion = (await this.#commands.run("pi", ["--version"])).stdout.trim();
      await this.#commands.run("docker", [
        "build", "--tag", GENERIC_IMAGE, "--build-arg", `PI_VERSION=${piVersion}`,
        "--file", join(packageRoot, "docker", "worker.Dockerfile"), packageRoot,
      ]);
    }
    this.#resolvedImages.set(GENERIC_IMAGE, GENERIC_IMAGE);
    return GENERIC_IMAGE;
  }
}
