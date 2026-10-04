import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatConfig, loadConfig } from "../config.js";
import type { MainOrchestrator } from "../runtime/main.js";
import { systemCommandRunner } from "../runtime/commands.js";
import { MainLock } from "../runtime/main-lock.js";
import { MerroStore } from "../store/store.js";
import { initializeWorkspace, isWorkspace, requireWorkspace } from "../runtime/workspace.js";
import { formatChangeDetails, formatOverview, formatStatus, presentChangeDetails, presentWorkspace, publicText } from "../runtime/presentation.js";

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

const commandUsage = "Commands: /merro · /merro init · /merro status · /merro <change> [--history] · /merro watch <change> · /merro issue create|list|show|start|approve|dismiss · /merro approve [change] · /merro leave [change] · /merro retry [change] · /merro stop [objective] · /merro run · /merro export · /merro unlock · /merro config [--all]";
const issueUsage = "Usage: /merro issue create <title> [--project <name>] [--body <text>] · list [--project <name>] · show #<n> [--project <name>] · start #<n> [--project <name>] · approve [<n>] · dismiss [<n>]";

interface IssueArguments { positional: string; project: string | undefined; body: string }

/** `--body` takes the rest of the line; `--project` takes one word. */
function parseIssueArguments(text: string): IssueArguments {
  let rest = text;
  let body = "";
  const bodyAt = rest.search(/(^|\s)--body(\s|$)/);
  if (bodyAt >= 0) {
    body = rest.slice(bodyAt).replace(/^\s*--body\s*/, "");
    rest = rest.slice(0, bodyAt);
  }
  let project: string | undefined;
  rest = rest.replace(/(^|\s)--project\s+(\S+)/, (_match, lead: string, slug: string) => { project = slug; return lead; });
  return { positional: rest.trim().replace(/\s+/g, " "), project, body };
}

function issueNumber(value: string): number {
  const match = /^#?(\d+)$/.exec(value.trim());
  if (!match) throw new Error(issueUsage);
  return Number(match[1]);
}

async function runIssueCommand(main: MainOrchestrator, text: string): Promise<string> {
  const [action = "", ...words] = text.trim().split(/\s+/).filter(Boolean);
  const args = parseIssueArguments(words.join(" "));
  if (action === "create") {
    if (!args.positional) throw new Error(issueUsage);
    const issue = await main.createIssue(args.project, args.positional, args.body);
    return `Created ${issue.projectSlug} #${issue.number}: ${issue.title}\n${issue.url}`;
  }
  if (action === "list") {
    const { projectSlug, issues } = await main.listIssues(args.project);
    const lines = [issues.length ? `Open issues in ${projectSlug}:` : `No open issues in ${projectSlug}.`,
      ...issues.map((issue) => `  #${issue.number} ${issue.title}${issue.labels.length ? ` [${issue.labels.join(", ")}]` : ""}`)];
    const proposals = await main.issueProposals();
    if (proposals.length) {
      lines.push("", "Proposed by workers, waiting for you:",
        ...proposals.map((proposal) => `  ${proposal.position}. ${proposal.title} (${proposal.projectSlug}, from ${proposal.change})`),
        "Create: /merro issue approve <n> · Dismiss: /merro issue dismiss <n>");
    }
    return lines.join("\n");
  }
  if (action === "show") {
    const issue = await main.showIssue(args.project, issueNumber(args.positional));
    return `${issue.projectSlug} #${issue.number} · ${issue.state.toLowerCase()}\n${issue.title}\n${issue.url}${issue.labels.length ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.body.trim() || "(no description)"}`;
  }
  if (action === "start") {
    const started = await main.startIssue(args.project, issueNumber(args.positional));
    return `Started #${started.issue.number}: ${started.issue.title}\nChanges: ${started.changeSets.map((item) => item.slug).join(", ")}`;
  }
  if (action === "approve" || action === "dismiss") {
    const proposals = await main.issueProposals();
    const position = args.positional ? Number(args.positional) : proposals.length === 1 ? proposals[0]!.position : Number.NaN;
    if (!Number.isInteger(position)) throw new Error(proposals.length ? "Choose a proposed issue number from /merro issue list." : "No proposed issues.");
    return main.resolveIssueProposal(position, action === "approve");
  }
  throw new Error(issueUsage);
}

export function registerCommands(pi: PiExtensionLike, cwd = process.cwd(), main?: MainOrchestrator, onInitialized?: () => Promise<void>, commands: Pick<typeof systemCommandRunner, "run"> = systemCommandRunner): void {
  const showStatus = async (ctx: CommandContext, full: boolean) => {
    const snapshot = main ? await main.publicSnapshot() : await withStore(cwd, presentWorkspace);
    report(ctx, full ? formatStatus(snapshot) : formatOverview(snapshot));
  };
  const showDetails = async (name: string, ctx: CommandContext, history: boolean) => {
    const details = main
      ? await main.changeDetails(name)
      : await withStore(cwd, (store) => presentChangeDetails(store, name));
    report(ctx, formatChangeDetails(details, { history }));
  };
  const watch = async (name: string, ctx: CommandContext) => {
    if (!main) { report(ctx, "Open Main to watch a change.", "warning"); return; }
    if (!name) { report(ctx, "Usage: /merro watch <change>", "warning"); return; }
    const target = await main.watchTarget(name);
    if (!target) { report(ctx, `${name} has no running worker to watch.`); return; }
    const session = `=${target.session}`;
    const window = `${session}:=${target.window}`;
    if (process.env.TMUX) {
      // switch-client accepts a window target; attach-session does not, so outside tmux select the window first.
      await commands.run("tmux", ["switch-client", "-t", window]);
      report(ctx, `Switched to ${target.window}.`);
    } else report(ctx, `Watch ${name}:\n  tmux select-window -t '${window}' && tmux attach-session -t '${session}'`);
  };
  const runMerro = async (args: string, ctx: CommandContext) => {
    const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const target = rest.join(" ");
    if (!verb || verb === "status") await requireWorkspace(cwd);
    try {
      if (target && ["init", "status", "run", "export", "unlock"].includes(verb ?? "") || verb === "config" && target !== "" && target !== "--all") {
        report(ctx, commandUsage, "warning");
        return;
      }
      if (!verb) { await showStatus(ctx, false); return; }
      if (verb === "init") {
        const alreadyInitialized = await isWorkspace(cwd);
        if (alreadyInitialized) { report(ctx, "Merro already initialized."); return; }
        await initializeWorkspace(cwd);
        report(ctx, `Merro initialized in ${cwd}.\n\nCreated:\n  .merro/\n  .merro/config.json\n  .merro/WORKSPACE.md\n  .merro/IMPLEMENTER.md\n  .merro/REVIEWER.md\n  .merro/projects/\n  projects/\n  .wt/\n\nNext:\n  register <repo-or-path> as <name>`);
        await onInitialized?.();
        return;
      }
      if (verb === "status") { await showStatus(ctx, true); return; }
      if (verb === "config") {
        await requireWorkspace(cwd);
        const path = resolve(cwd, ".merro", "config.json");
        const config = await loadConfig(path);
        // Config contains user-owned values, not private orchestration identities.
        const message = formatConfig(path, config, target === "--all");
        if (ctx.ui) ctx.ui.notify(message, "info");
        else console.log(message);
        return;
      }
      if (verb === "export") {
        const snapshot = main ? await main.publicSnapshot() : await withStore(cwd, presentWorkspace);
        const path = join(cwd, ".merro", "export.json");
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
        report(ctx, "Merro status exported to .merro/export.json");
        return;
      }
      if (verb === "unlock") {
        await requireWorkspace(cwd);
        const lock = new MainLock(join(cwd, ".merro", "main.lock.db"));
        await lock.acquire();
        await lock.release();
        report(ctx, "Merro lock is clear.");
        return;
      }
      if (verb === "issue") {
        if (!main) { report(ctx, "Open Main to work with issues.", "warning"); return; }
        report(ctx, await runIssueCommand(main, target));
        return;
      }
      if (verb === "approve" || verb === "leave") {
        if (!main) { report(ctx, `Open Main to ${verb === "approve" ? "approve a plan or" : "resolve"} a merge decision.`, "warning"); return; }
        report(ctx, verb === "approve" ? await main.approvePending(target || undefined) : await main.resolveDecisionForChange(target || undefined, false));
        return;
      }
      if (verb === "retry") {
        if (!main) { report(ctx, "Open Main to retry a change.", "warning"); return; }
        report(ctx, await main.retryChangeSet(target || undefined));
        return;
      }
      if (verb === "stop") {
        if (!main && target) { report(ctx, "Open Main to stop a named Objective.", "warning"); return; }
        const stopped = main ? await main.stopObjectives(target || undefined) : await withStore(cwd, (store) => store.stopActiveObjectives());
        report(ctx, stopped ? `Stopped ${stopped} Objective${stopped === 1 ? "" : "s"}. Active changes will finish; no new work will start.` : "Nothing to stop.");
        return;
      }
      if (verb === "run") {
        if (!main) { report(ctx, "Open Main to check current work.", "warning"); return; }
        await main.runPass();
        report(ctx, "Checked current work.");
        return;
      }
      if (verb === "watch") { await watch(target, ctx); return; }
      if (!target) { await showDetails(verb, ctx, false); return; }
      if (target === "--history") { await showDetails(verb, ctx, true); return; }
      report(ctx, commandUsage, "warning");
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), "warning");
    }
  };

  pi.registerCommand("merro", { description: "Merro: init, status, issue, <change>, watch, approve, leave, retry, stop, run, export, unlock, config", handler: runMerro });
}
