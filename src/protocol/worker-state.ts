import { readFile, rename, writeFile } from "node:fs/promises";

export interface WorkerState {
  state: "busy" | "idle" | "finished";
  lastActivity: string;
  updatedAt: string;
}
let writes: Promise<void> = Promise.resolve();

/** Workers publish events outside Main's database; a finished state never regresses. */
export async function publishWorkerState(path: string, state: WorkerState["state"], activity: string): Promise<void> {
  const operation = writes.then(async () => {
    try {
      const previous = JSON.parse(await readFile(path, "utf8")) as WorkerState;
      if (previous.state === "finished") return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ state, lastActivity: activity, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await rename(temporary, path);
  });
  writes = operation.catch(() => undefined);
  return operation;
}
