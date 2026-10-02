import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import { MerroStore } from "../store/store.js";
import { MainLock } from "./main-lock.js";
import { CommandError, systemCommandRunner, type CommandRunner } from "./commands.js";

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
  await access(cwd, constants.W_OK);
  const version = (await commands.run("pi", ["--version"], { cwd })).stdout.trim();
  if (!version) throw new Error("Pi validation failed: install Pi and ensure it is on PATH.");
  const help = (await commands.run("pi", ["--help"], { cwd })).stdout;
  if (!help.includes("--tui-mode")) throw new Error("Pi must support --tui-mode regular. Update Pi before initializing Merro.");
  await commands.run("tmux", ["-V"], { cwd });
  // Git is optional for workspace setup; only use it to exclude local state.
  let inWorkingTree = false;
  try {
    inWorkingTree = (await commands.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd, env: { LC_ALL: "C" } })).stdout.trim() === "true";
  } catch (error) {
    if (!(error instanceof CommandError) || !(error.causeCode === "ENOENT" || (error.exitCode === 128 && error.stderr.includes("not a git repository")))) throw error;
  }
  let exclude: string | undefined;
  let entries: string[] = [];
  if (inWorkingTree) {
    exclude = (await commands.run("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd })).stdout.trim();
    if (!exclude) throw new Error("Git did not return its exclude path.");
    // Patterns are relative to the repository root, including a workspace in a subdirectory.
    const prefix = (await commands.run("git", ["rev-parse", "--show-prefix"], { cwd })).stdout.trim();
    entries = [`/${prefix}.wt/`, `/${prefix}.merro/`];
  }
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
    if (exclude) {
      let current = "";
      try { current = await readFile(exclude, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry));
      if (missing.length) {
        await mkdir(dirname(exclude), { recursive: true });
        await writeFile(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
      }
    }
    new MerroStore(join(cwd, ".merro", "state.db")).close();
  } finally { await lock.release(); }
}
