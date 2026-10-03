import { readFile } from "node:fs/promises";

interface WorkerGuidanceEvent {
  systemPromptOptions: { sections: Record<string, string> };
}

interface WorkerGuidanceAPI {
  on(event: "before_agent_start", handler: (event: WorkerGuidanceEvent) => void): void;
}

export default async function merroWorkerGuidance(pi: WorkerGuidanceAPI): Promise<void> {
  if (process.env.MERRO_RUNTIME !== "worker") return;
  const path = process.env.MERRO_WORKER_GUIDANCE_PATH;
  if (!path) throw new Error("Worker guidance path is missing.");
  const guidance = (await readFile(path, "utf8")).trim();
  if (!guidance) throw new Error("Worker guidance is empty.");

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.merro_worker_guidance = guidance;
  });
}
