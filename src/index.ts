import { join } from "node:path";
import { loadConfig } from "./config.js";
import { MainOrchestrator } from "./runtime/main.js";
import { registerCommands, type PiExtensionLike } from "./tools/commands.js";
import { registerMainTools, type MainToolAPI } from "./tools/main.js";

interface MerroExtensionAPI extends PiExtensionLike, MainToolAPI {
  on(event: "session_start" | "session_shutdown", handler: () => void): void;
}

/** Pi package entrypoint. Main state is reconciled on startup and while work remains active. */
export default async function merro(pi: MerroExtensionAPI): Promise<void> {
  if (process.env.MERRO_RUNTIME === "worker") return;
  const workspacePath = process.cwd();
  const config = await loadConfig(join(workspacePath, ".merro", "config.json"));
  const main = new MainOrchestrator({ workspacePath, config });
  registerCommands(pi, workspacePath, main);
  registerMainTools(pi, main);

  let timer: NodeJS.Timeout | undefined;
  let passRunning = false;
  const reconcile = async (): Promise<void> => {
    if (passRunning) return;
    passRunning = true;
    try {
      await main.runPass();
    } catch (error) {
      console.error(`Merro reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      passRunning = false;
    }
  };

  pi.on("session_start", () => {
    void reconcile();
    timer ??= setInterval(() => { void reconcile(); }, 10_000);
  });
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
