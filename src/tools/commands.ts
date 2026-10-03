import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.js";
import type { MainOrchestrator } from "../runtime/main.js";
import { MainLock } from "../runtime/main-lock.js";
import { MerroStore } from "../store/store.js";
import { initializeWorkspace, isWorkspace, requireWorkspace } from "../runtime/workspace.js";
import { formatChangeDetails, formatStatus, presentChangeDetails, presentWorkspace, publicText } from "../runtime/presentation.js";

interface CommandContext { ui?: { notify(message: string, level?: "info" | "warning" | "error"): void } }
export interface PiExtensionLike {
  registerCommand(name: string, config: { description: string; handler: (args: string, ctx: CommandContext) => void | Promise<void> }): void;
}
function report(ctx: CommandContext, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.ui) ctx.ui.notify(publicText(message), level);
  else console.log(publicText(message));
}
async function withStore<T>(cwd: string, action: (store: MerroStore) => T | Promise<T>): Promise<T> {
  await requireWorkspace(cwd);
  const dir = join(cwd, ".merro");
  const lock = new MainLock(join(dir, "main.lock.db"));
  await lock.acquire();
  let store: MerroStore | undefined;
  try { store = new MerroStore(join(dir, "state.db")); return await action(store); }
  finally { try { store?.close(); } finally { await lock.release(); } }
}

const commandUsage = "Commands: /merro · /merro init · /merro status · /merro <change> · /merro approve [change] · /merro leave [change] · /merro retry [change] · /merro stop [objective] · /merro run · /merro export · /merro unlock · /merro config";

export function registerCommands(pi: PiExtensionLike, cwd = process.cwd(), main?: MainOrchestrator, onInitialized?: () => Promise<void>): void {
  const showStatus = async (ctx: CommandContext) => {
    const snapshot = main ? await main.publicSnapshot() : await withStore(cwd, presentWorkspace);
    report(ctx, formatStatus(snapshot));
  };
  const showDetails = async (name: string, ctx: CommandContext) => {
    const details = main
      ? await main.changeDetails(name)
      : await withStore(cwd, (store) => presentChangeDetails(store, name));
    report(ctx, formatChangeDetails(details));
  };
  const runMerro = async (args: string, ctx: CommandContext) => {
    const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const target = rest.join(" ");
    if (!verb || verb === "status") await requireWorkspace(cwd);
    try {
      if (target && ["init", "status", "run", "export", "unlock", "config"].includes(verb ?? "")) {
        report(ctx, commandUsage, "warning");
        return;
      }
      if (!verb) { await showStatus(ctx); return; }
      if (verb === "init") {
        const alreadyInitialized = await isWorkspace(cwd);
        if (alreadyInitialized) { report(ctx, "Merro already initialized."); return; }
        await initializeWorkspace(cwd);
        report(ctx, `Merro initialized in ${cwd}.\n\nCreated:\n  .merro/\n  .merro/config.json\n  .merro/WORKSPACE.md\n  .merro/IMPLEMENTER.md\n  .merro/REVIEWER.md\n  .merro/projects/\n  projects/\n  .wt/\n\nNext:\n  register <repo-or-path> as <name>`);
        await onInitialized?.();
        return;
      }
      if (verb === "status") { await showStatus(ctx); return; }
      if (verb === "config") {
        await requireWorkspace(cwd);
        const path = resolve(cwd, ".merro", "config.json");
        const config = await loadConfig(path);
        // Config contains user-owned values, not private orchestration identities.
        const message = `Config: ${path}\n\n${JSON.stringify(config, null, 2)}`;
        if (ctx.ui) ctx.ui.notify(message, "info");
        else console.log(message);
        return;
      }
      if (verb === "export") {
        const snapshot = main ? await main.publicSnapshot() : await withStore(cwd, presentWorkspace);
        const path = join(cwd, ".merro", "export.json");
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
        report(ctx, "Merro status exported to .merro/export.json");
        return;
      }
      if (verb === "unlock") {
        await requireWorkspace(cwd);
        const lock = new MainLock(join(cwd, ".merro", "main.lock.db"));
        await lock.acquire();
        await lock.release();
        report(ctx, "Merro lock is clear.");
        return;
      }
      if (verb === "approve" || verb === "leave") {
        if (!main) { report(ctx, "Open Main to resolve a merge decision.", "warning"); return; }
        report(ctx, await main.resolveDecisionForChange(target || undefined, verb === "approve"));
        return;
      }
      if (verb === "retry") {
        if (!main) { report(ctx, "Open Main to retry a change.", "warning"); return; }
        report(ctx, await main.retryChangeSet(target || undefined));
        return;
      }
      if (verb === "stop") {
        if (!main && target) { report(ctx, "Open Main to stop a named Objective.", "warning"); return; }
        const stopped = main ? await main.stopObjectives(target || undefined) : await withStore(cwd, (store) => store.stopActiveObjectives());
        report(ctx, stopped ? `Stopped ${stopped} Objective${stopped === 1 ? "" : "s"}. Active changes will finish; no new work will start.` : "Nothing to stop.");
        return;
      }
      if (verb === "run") {
        if (!main) { report(ctx, "Open Main to check current work.", "warning"); return; }
        await main.runPass();
        report(ctx, "Checked current work.");
        return;
      }
      if (!target) { await showDetails(verb, ctx); return; }
      report(ctx, commandUsage, "warning");
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), "warning");
    }
  };

  pi.registerCommand("merro", { description: "Merro: init, status, <change>, approve, leave, retry, stop, run, export, unlock, config", handler: runMerro });
}
