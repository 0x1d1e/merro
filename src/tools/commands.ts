import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MerroStore } from "../store/store.js";
import { MainAlreadyRunningError, MainLock } from "../runtime/main-lock.js";
import type { MainOrchestrator } from "../runtime/main.js";

interface CommandContext {
  ui?: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

export interface PiExtensionLike {
  registerCommand(name: string, config: {
    description: string;
    handler: (args: string, ctx: CommandContext) => void | Promise<void>;
  }): void;
}

function report(ctx: CommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.ui) ctx.ui.notify(message, level);
  else console.log(message);
}

async function withStore<T>(cwd: string, action: (store: MerroStore) => T | Promise<T>): Promise<T> {
  const dir = join(cwd, ".merro");
  await mkdir(dir, { recursive: true });
  const lock = new MainLock(join(dir, "main.lock.db"));
  await lock.acquire();
  let store: MerroStore | undefined;
  try {
    store = new MerroStore(join(dir, "state.db"));
    return await action(store);
  } finally {
    try {
      store?.close();
    } finally {
      await lock.release();
    }
  }
}

export function registerCommands(pi: PiExtensionLike, cwd = process.cwd(), main?: MainOrchestrator): void {
  pi.registerCommand("status", {
    description: "Show Merro workspace status",
    async handler(_args, ctx) {
      const status = await withStore(cwd, (store) => store.statusSummary());
      report(ctx, `Merro: ${status.objectives} active objective(s), ${status.workItems} active WorkItem(s), ${status.activeTasks} active Task(s), ${status.blockedWorkItems} blocked.`);
    },
  });

  pi.registerCommand("export", {
    description: "Export Merro SQLite state to .merro/export.json",
    async handler(_args, ctx) {
      const snapshot = await withStore(cwd, (store) => store.snapshot());
      const path = join(cwd, ".merro", "export.json");
      await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      report(ctx, `Merro state exported to ${path}`);
    },
  });

  pi.registerCommand("stop", {
    description: "Soft-stop active Merro objectives, optionally by Objective ID",
    async handler(args, ctx) {
      const objectiveId = args.trim() || undefined;
      const stopped = main
        ? await main.stopObjectives(objectiveId)
        : await withStore(cwd, (store) => store.stopActiveObjectives(objectiveId));
      report(ctx, `Stopped ${stopped} active objective(s). Exclusive unfinished WorkItems are obsolete; active Tasks are not killed.`);
    },
  });

  pi.registerCommand("unlock", {
    description: "Clear stale Merro lock metadata if Main is not running",
    async handler(_args, ctx) {
      const dir = join(cwd, ".merro");
      await mkdir(dir, { recursive: true });
      const lock = new MainLock(join(dir, "main.lock.db"));
      try {
        await lock.acquire();
        await lock.release();
        report(ctx, "Merro lock is clear.");
      } catch (error) {
        if (error instanceof MainAlreadyRunningError) {
          report(ctx, error.message, "warning");
          return;
        }
        throw error;
      }
    },
  });

  if (main) {
    for (const [name, approved] of [["merro-approve", true], ["merro-reject", false]] as const) {
      pi.registerCommand(name, {
        description: approved
          ? "Approve a merge Decision or authorize an implementer to resolve a merge conflict"
          : "Reject a merge Decision or abandon a merge-conflict resolution",
        async handler(args, ctx) {
          const decisionId = args.trim();
          if (!decisionId || /\s/.test(decisionId)) throw new Error(`Usage: /${name} <Decision ID>`);
          await main.resolveMergeDecision(decisionId, approved);
          report(ctx, `Decision ${decisionId} ${approved ? "approved or resolved" : "rejected or abandoned"}.`);
        },
      });
    }
    pi.registerCommand("merro-continue", {
      description: "Continue a Blocked Merro WorkItem after fixing its cause",
      async handler(args, ctx) {
        const workItemId = args.trim();
        if (!workItemId || /\s/.test(workItemId)) throw new Error("Usage: /merro-continue <WorkItem ID>");
        await main.continueWorkItem(workItemId);
        report(ctx, `Continued WorkItem ${workItemId}.`);
      },
    });
    pi.registerCommand("merro-run", {
      description: "Reconcile Merro Tasks and pull requests, then schedule available work",
      async handler(_args, ctx) {
        await main.runPass();
        report(ctx, "Merro reconciliation and scheduling pass completed.");
      },
    });
  }
}
