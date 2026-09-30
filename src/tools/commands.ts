import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MerroStore } from "../store/store.js";

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

async function withStore<T>(cwd: string, action: (store: MerroStore) => T): Promise<T> {
  const dir = join(cwd, ".merro");
  await mkdir(dir, { recursive: true });
  const store = new MerroStore(join(dir, "state.db"));
  try {
    return action(store);
  } finally {
    store.close();
  }
}

export function registerCommands(pi: PiExtensionLike, cwd = process.cwd()): void {
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
    description: "Soft-stop active Merro objectives",
    async handler(_args, ctx) {
      const stopped = await withStore(cwd, (store) => store.stopActiveObjectives());
      report(ctx, `Stopped ${stopped} active objective(s). Active Tasks are not killed.`);
    },
  });
}
