import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import { assertProjectSlug } from "../domain/project.js";
import { MerroStore } from "../store/store.js";
import { GitClient } from "../vcs/git.js";
import { GitHubClient } from "../github/client.js";
import { MainLock } from "./main-lock.js";
import { systemCommandRunner, type CommandRunner } from "./commands.js";

export const INITIALIZATION_REQUIRED = "Merro is not initialized here. Run /merro init.";

export async function isWorkspace(cwd: string): Promise<boolean> {
  try {
    const directory = await lstat(join(cwd, ".merro"));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("cwd/.merro must be a real directory.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function requireWorkspace(cwd: string): Promise<void> {
  if (!await isWorkspace(cwd)) throw new Error(INITIALIZATION_REQUIRED);
  for (const filename of ["config.json", "state.db"]) {
    try {
      const file = await lstat(join(cwd, ".merro", filename));
      if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Merro ${filename} must be a regular file.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`Merro workspace is incomplete (${filename} missing). Run /merro init.`);
    }
  }
}

/** Explicit initialization only. Validate dependencies before writing workspace state. */
export async function initializeWorkspace(cwd: string, commands: CommandRunner = systemCommandRunner): Promise<void> {
  cwd = resolve(cwd);
  if ((await commands.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd })).stdout.trim() !== "true") throw new Error("Run /merro init inside a Git working tree.");
  await access(cwd, constants.W_OK);
  const version = (await commands.run("pi", ["--version"], { cwd })).stdout.trim();
  if (!version) throw new Error("Pi validation failed: install Pi and ensure it is on PATH.");
  const help = (await commands.run("pi", ["--help"], { cwd })).stdout;
  if (!help.includes("--tui-mode")) throw new Error("Pi must support --tui-mode regular. Update Pi before initializing Merro.");
  await commands.run("tmux", ["-V"], { cwd });
  await commands.run("gh", ["auth", "status"], { cwd });
  const git = new GitClient(commands);
  const repo = await new GitHubClient(commands).repositoryInDirectory(cwd);
  const slug = repo.nameWithOwner.split("/").at(-1)?.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || basename(cwd);
  assertProjectSlug(slug);
  const project = await git.discoverProject(cwd, slug);
  const exclude = (await commands.run("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd })).stdout.trim();
  if (!exclude) throw new Error("Git did not return its exclude path.");
  if (!await isWorkspace(cwd)) await mkdir(join(cwd, ".merro"), { mode: 0o700 });
  const lock = new MainLock(join(cwd, ".merro", "main.lock.db"));
  await lock.acquire();
  try {
    const config = join(cwd, ".merro", "config.json");
    try {
      await writeFile(config, `${JSON.stringify({ max_concurrent_tasks: DEFAULT_CONFIG.max_concurrent_tasks, max_review_rounds: DEFAULT_CONFIG.max_review_rounds }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await loadConfig(config);
    await mkdir(join(cwd, ".merro", "runtime"), { recursive: true, mode: 0o700 });
    await mkdir(join(cwd, ".wt"), { recursive: true });
    let current = "";
    try { current = await readFile(exclude, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Patterns are relative to the repository root, including initialization in a subdirectory.
    const prefix = (await commands.run("git", ["rev-parse", "--show-prefix"], { cwd })).stdout.trim();
    const entries = [`/${prefix}.wt/`, `/${prefix}.merro/`];
    const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry));
    if (missing.length) {
      await mkdir(dirname(exclude), { recursive: true });
      await writeFile(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
    }
    const store = new MerroStore(join(cwd, ".merro", "state.db"));
    try {
      const existing = store.getProject(slug);
      if (!existing) store.createProject({ ...project, defaultBranch: repo.defaultBranch });
      else if (existing.baseRemote !== project.baseRemote || existing.pushRemote !== project.pushRemote) {
        throw new Error(`Project ${slug} repository identity changed. Confirm its remotes before continuing.`);
      }
    } finally { store.close(); }
  } finally { await lock.release(); }
}
