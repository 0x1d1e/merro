import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MainOrchestrator } from "../runtime/main.js";
import { MainAlreadyRunningError, MainLock } from "../runtime/main-lock.js";
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
      if (!verb) { await showStatus(ctx); return; }
      if (verb === "init") {
        const alreadyInitialized = await isWorkspace(cwd);
        await initializeWorkspace(cwd);
        report(ctx, alreadyInitialized ? "Merro is already initialized." : "Merro initialized.\n\nNext: ask Main to register a Project and propose an Objective.");
        await onInitialized?.();
        return;
      }
      if (verb === "status") { await showStatus(ctx); return; }
      if (verb === "details") {
        if (!target) { report(ctx, "Usage: /merro details <change>", "warning"); return; }
        await showDetails(target, ctx);
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
      if (!target && !["approve", "leave", "retry", "stop", "run", "status", "details", "init"].includes(verb)) {
        await showDetails(verb, ctx);
        return;
      }
      report(ctx, "Commands: /merro · /merro init · /merro status · /merro <change> · /merro approve [change] · /merro retry [change] · /merro stop [change]", "warning");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report(ctx, message, "warning");
    }
  };

  pi.registerCommand("merro", { description: "Show work, inspect a change, or manage Merro: /merro [status|<change>|approve|retry|stop]", handler: runMerro });
  pi.registerCommand("status", { description: "Show concise Merro status", async handler(_args, ctx) {
    await requireWorkspace(cwd);
    await showStatus(ctx);
  } });
  pi.registerCommand("merro-export", { description: "Export user-facing status to .merro/export.json", async handler(_args, ctx) {
    const snapshot = main ? await main.publicSnapshot() : await withStore(cwd, presentWorkspace);
    const path = join(cwd, ".merro", "export.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    report(ctx, "Merro status exported to .merro/export.json");
  } });
  pi.registerCommand("stop", { description: "Stop active Objectives; running changes finish", async handler(args, ctx) {
    const target = args.trim() || undefined;
    if (!main && target) { report(ctx, "Open Main to stop a named Objective.", "warning"); return; }
    const stopped = main ? await main.stopObjectives(target) : await withStore(cwd, (store) => store.stopActiveObjectives());
    report(ctx, stopped ? `Stopped ${stopped} Objective${stopped === 1 ? "s" : ""}.` : "Nothing to stop.");
  } });
  pi.registerCommand("unlock", { description: "Clear stale Main ownership; never bypass a live Main", async handler(_args, ctx) {
    try {
      await requireWorkspace(cwd);
      const lock = new MainLock(join(cwd, ".merro", "main.lock.db"));
      try { await lock.acquire(); await lock.release(); report(ctx, "Merro lock is clear."); }
      catch (error) { if (error instanceof MainAlreadyRunningError) report(ctx, error.message, "warning"); else throw error; }
    } catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "warning"); }
  } });
  if (!main) return;

  for (const [name, approved] of [["merro-approve", true], ["merro-reject", false]] as const) {
    pi.registerCommand(name, { description: `Compatibility alias for /merro ${approved ? "approve" : "leave"} [change]`, async handler(args, ctx) {
      try { report(ctx, await main.resolveDecisionForChange(args.trim() || undefined, approved)); }
      catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "warning"); }
    } });
  }
  pi.registerCommand("merro-retry", { description: "Compatibility alias for /merro retry [change]", async handler(args, ctx) {
    try { report(ctx, await main.retryChangeSet(args.trim() || undefined)); }
    catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "warning"); }
  } });
  pi.registerCommand("merro-run", { description: "Check current work", async handler(_args, ctx) {
    try { await main.runPass(); report(ctx, "Checked current work."); }
    catch (error) { report(ctx, error instanceof Error ? error.message : String(error), "warning"); }
  } });
}
