import { registerCommands, type PiExtensionLike } from "./tools/commands.js";

/** Pi package entrypoint. Runtime orchestration is added incrementally behind this stable surface. */
export default function merro(pi: PiExtensionLike): void {
  registerCommands(pi);
}
