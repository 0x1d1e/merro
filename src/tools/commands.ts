import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MainOrchestrator } from "../runtime/main.js";
import { MainAlreadyRunningError, MainLock } from "../runtime/main-lock.js";
import { MerroStore } from "../store/store.js";
import { initializeWorkspace, requireWorkspace } from "../runtime/workspace.js";
import { formatStatus, presentWorkspace, publicText } from "../runtime/presentation.js";

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
  pi.registerCommand("merro", { description: "Initialize this Git repository: /merro init", async handler(args, ctx) {
    if (args.trim() !== "init") throw new Error("Usage: /merro init");
    await initializeWorkspace(cwd);
    report(ctx, "Merro initialized.");
    await onInitialized?.();
  } });
  pi.registerCommand("status", { description: "Show Merro changes", async handler(_args, ctx) {
    const snapshot = main ? await main.publicSnapshot() : await withStore(cwd, presentWorkspace);
    report(ctx, formatStatus(snapshot));
  } });
  pi.registerCommand("merro-export", { description: "Export normal status to .merro/export.json", async handler(_args, ctx) {
    const snapshot = main ? await main.publicSnapshot() : await withStore(cwd, presentWorkspace);
    const path = join(cwd, ".merro", "export.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    report(ctx, "Merro status exported to .merro/export.json");
  } });
  pi.registerCommand("stop", { description: "Soft-stop objectives by goal or change name; active workers finish", async handler(args, ctx) {
    const name = args.trim() || undefined;
    if (!main && name) throw new Error("Open Main to stop an objective by name.");
    const stopped = main ? await main.stopObjectives(name) : await withStore(cwd, (store) => store.stopActiveObjectives());
    report(ctx, `Stopped ${stopped} objective(s). Active workers finish; no successors start.`);
  } });
  pi.registerCommand("unlock", { description: "Clear stale Main ownership; never bypass a live Main", async handler(_args, ctx) {
    await requireWorkspace(cwd);
    const lock = new MainLock(join(cwd, ".merro", "main.lock.db"));
    try { await lock.acquire(); await lock.release(); report(ctx, "Merro lock is clear."); }
    catch (error) { if (error instanceof MainAlreadyRunningError) report(ctx, error.message, "warning"); else throw error; }
  } });
  if (!main) return;
  for (const [name, approved] of [["merro-approve", true], ["merro-reject", false]] as const) {
    pi.registerCommand(name, { description: `${approved ? "Approve" : "Reject"} a pending merge/conflict by change name`, async handler(args, ctx) {
      await main.resolveDecisionForChange(args.trim(), approved);
      report(ctx, "Decision resolved.");
    } });
  }
  pi.registerCommand("merro-continue", { description: "Retry a blocked change: /merro-continue <change name>", async handler(args, ctx) {
    if (!args.trim()) throw new Error("Name the change to retry.");
    await main.continueChangeSet(args.trim());
    report(ctx, `Continued ${args.trim()}.`);
  } });
  pi.registerCommand("merro-run", { description: "Reconcile workers and GitHub, then schedule approved work", async handler(_args, ctx) {
    await main.runPass(); report(ctx, "Merro reconciled.");
  } });
}
