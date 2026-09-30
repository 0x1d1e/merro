import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface MainLockOwner {
  pid: number;
  processStartedAt: string;
  acquiredAt: string;
  sessionId: string;
}

export class MainAlreadyRunningError extends Error {
  readonly owner: MainLockOwner | null;

  constructor(owner: MainLockOwner | null) {
    const details = owner
      ? ` (pid ${owner.pid}, started ${owner.processStartedAt})`
      : " (owner metadata unavailable)";
    super(`Merro Main already holds the workspace lock${details}`);
    this.name = "MainAlreadyRunningError";
    this.owner = owner;
  }
}

/** An OS-released SQLite exclusive lock serializes Main across crashes and PID reuse. */
export class MainLock {
  readonly #databasePath: string;
  readonly #ownerPath: string;
  #db: DatabaseSync | null = null;
  #owner: MainLockOwner | null = null;

  constructor(databasePath: string) {
    this.#databasePath = databasePath;
    this.#ownerPath = databasePath.replace(/\.db$/, ".json");
  }

  get owner(): MainLockOwner | null {
    return this.#owner;
  }

  async acquire(): Promise<void> {
    if (this.#db) return;

    await mkdir(dirname(this.#databasePath), { recursive: true });
    const db = new DatabaseSync(this.#databasePath);
    db.exec("PRAGMA busy_timeout = 0");
    try {
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      db.close();
      throw new MainAlreadyRunningError(await this.#readOwner());
    }

    const owner: MainLockOwner = {
      pid: process.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      acquiredAt: new Date().toISOString(),
      sessionId: randomUUID(),
    };
    this.#db = db;
    this.#owner = owner;

    const tempPath = `${this.#ownerPath}.${owner.sessionId}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(tempPath, this.#ownerPath);
    } catch (error) {
      await rm(tempPath, { force: true });
      await this.release();
      throw error;
    }
  }

  async release(): Promise<void> {
    const db = this.#db;
    const owner = this.#owner;
    if (!db) return;

    this.#db = null;
    this.#owner = null;
    try {
      const currentOwner = await this.#readOwner();
      if (owner && currentOwner?.sessionId === owner.sessionId) {
        await rm(this.#ownerPath, { force: true });
      }
    } finally {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Closing the connection releases the OS lock even if the transaction is already gone.
      }
      db.close();
    }
  }

  async #readOwner(): Promise<MainLockOwner | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#ownerPath, "utf8"));
      if (typeof value !== "object" || value === null) return null;
      const row = value as Record<string, unknown>;
      if (
        typeof row.pid !== "number" ||
        typeof row.processStartedAt !== "string" ||
        typeof row.acquiredAt !== "string" ||
        typeof row.sessionId !== "string"
      ) return null;
      return {
        pid: row.pid,
        processStartedAt: row.processStartedAt,
        acquiredAt: row.acquiredAt,
        sessionId: row.sessionId,
      };
    } catch {
      return null;
    }
  }
}
