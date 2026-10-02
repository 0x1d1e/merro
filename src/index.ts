import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { MainOrchestrator } from "./runtime/main.js";
import { loadMarkdownGuidance, renderMarkdownGuidance } from "./runtime/guidance.js";
import { isWorkspace } from "./runtime/workspace.js";
import { publicText } from "./runtime/presentation.js";
import { registerCommands, type PiExtensionLike } from "./tools/commands.js";
import { registerMainTools, type MainToolAPI } from "./tools/main.js";

interface MerroExtensionAPI extends PiExtensionLike, MainToolAPI {
  on(event: "session_start" | "session_shutdown", handler: () => void | Promise<void>): void;
  on(event: "before_agent_start", handler: (event: { systemPromptOptions: { sections: Record<string, string> } }) => Promise<void>): void;
}

export default async function merro(pi: MerroExtensionAPI): Promise<void> {
  if (process.env.MERRO_RUNTIME === "worker") return;
  const cwd = process.cwd();
  const config = { ...DEFAULT_CONFIG };
  const main = new MainOrchestrator({ workspacePath: cwd, config, notify(message) {
    pi.sendMessage?.({ customType: "merro-activity", content: message, display: true });
  } });
  let timer: NodeJS.Timeout | undefined;
  let passRunning = false;
  let sessionStarted = false;
  const reconcile = async () => {
    if (passRunning || !await isWorkspace(cwd)) return;
    passRunning = true;
    try { await main.runPass(); }
    catch (error) { console.error(publicText(`Merro reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)); }
    finally { passRunning = false; }
  };
  const open = async () => {
    if (!sessionStarted || !await isWorkspace(cwd)) return;
    try { Object.assign(config, await loadConfig(join(cwd, ".merro", "config.json"))); }
    catch (error) { console.error(publicText(`Merro could not open this workspace: ${error instanceof Error ? error.message : String(error)}`)); return; }
    await reconcile();
    timer ??= setInterval(() => { void reconcile(); }, 10_000);
  };
  registerCommands(pi, cwd, main, open);
  registerMainTools(pi, main);
  pi.on("before_agent_start", async (event) => {
    delete event.systemPromptOptions.sections.merro_workspace;
    if (!(await isWorkspace(cwd))) return;
    const projects = await main.listProjects();
    const guidance = renderMarkdownGuidance(await loadMarkdownGuidance(cwd, projects.map((project) => project.slug)));
    if (guidance) event.systemPromptOptions.sections.merro_workspace = guidance;
  });
  pi.on("session_start", async () => { sessionStarted = true; await open(); });
  pi.on("session_shutdown", () => { sessionStarted = false; if (timer) clearInterval(timer); timer = undefined; });
}
