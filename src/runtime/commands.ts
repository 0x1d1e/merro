import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(file: string, args: readonly string[], options?: CommandOptions): Promise<CommandOutput>;
}

export class CommandError extends Error {
  readonly file: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly causeCode: string | null;

  constructor(file: string, args: readonly string[], error: ExecFileException, stderr: string) {
    super(`${file} ${args.join(" ")} failed${error.code ? ` (${error.code})` : ""}: ${stderr.trim() || error.message}`);
    this.name = "CommandError";
    this.file = file;
    this.args = [...args];
    this.exitCode = typeof error.code === "number" ? error.code : null;
    this.stderr = stderr;
    this.causeCode = typeof error.code === "string" ? error.code : null;
  }
}

export const systemCommandRunner: CommandRunner = {
  run(file, args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(file, [...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        signal: options.signal,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes ?? 10 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new CommandError(file, args, error, stderr));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  },
};
