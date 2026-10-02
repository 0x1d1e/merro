import { Type } from "typebox";
import { parseObjectiveIssueScopes } from "../domain/objective.js";
import { changeName, issueNumbers } from "../domain/names.js";
import { formatStatus, publicText } from "../runtime/presentation.js";
import type { MainOrchestrator, ObjectiveStartInput } from "../runtime/main.js";

const empty = Type.Object({}, { additionalProperties: false });
const objectiveParameters = Type.Object({
  goal: Type.String(),
  project_slugs: Type.Array(Type.String(), { minItems: 1 }),
  change: Type.String({ description: "Semantic change name, such as plugin-lifecycle-safety. Never a database identifier." }),
  issues: Type.Array(Type.Union([
    Type.Object({ project_slug: Type.String(), numbers: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }) }, { additionalProperties: false }),
    Type.Object({ project_slug: Type.String(), query: Type.Object({ labels: Type.Optional(Type.Array(Type.String())), milestone: Type.Optional(Type.String()) }, { additionalProperties: false }) }, { additionalProperties: false }),
  ]), { minItems: 1 }),
  delivery: Type.Optional(Type.Union([Type.Literal("together"), Type.Literal("separate")])),
  priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")])),
}, { additionalProperties: false });

interface MainTool {
  name: string;
  label: string;
  description: string;
  parameters: object;
  execute(toolCallId: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}
export interface MainToolAPI {
  registerTool(tool: MainTool): void;
  sendMessage?(message: { customType: string; content: string; display: boolean; details?: unknown }): void;
}
function result(text: string, details: unknown = undefined) {
  return { content: [{ type: "text" as const, text: publicText(text) }], details: details === undefined ? undefined : JSON.parse(publicText(JSON.stringify(details))) as unknown };
}
function text(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string" || !args[key].trim()) throw new Error(`${key} must be a non-empty string`);
  return args[key];
}
function objectiveInput(args: Record<string, unknown>): ObjectiveStartInput {
  if (!Array.isArray(args.project_slugs) || args.project_slugs.some((slug) => typeof slug !== "string")) throw new Error("project_slugs must contain Project names");
  const projectSlugs = args.project_slugs as string[];
  if (!Array.isArray(args.issues)) throw new Error("issues must be an array");
  return {
    goal: text(args, "goal"), projectSlugs,
    changeSlug: text(args, "change"), delivery: args.delivery === "separate" ? "separate" : "together",
    issues: parseObjectiveIssueScopes(args.issues.map((scope) => {
      if (!scope || typeof scope !== "object") throw new Error("Issue selection must be an object");
      const row = scope as Record<string, unknown>;
      return { projectSlug: row.project_slug, ...("numbers" in row ? { numbers: row.numbers } : { query: row.query }) };
    }), projectSlugs),
    ...(args.priority ? { priority: args.priority as NonNullable<ObjectiveStartInput["priority"]> } : {}),
  };
}

export function registerMainTools(pi: MainToolAPI, main: MainOrchestrator): void {
  pi.registerTool({ name: "merro_add_project", label: "Register Project", description: "Register a GitHub Project after the user confirms its path and semantic name.",
    parameters: Type.Object({ path: Type.String(), slug: Type.String() }, { additionalProperties: false }),
    async execute(_id, args) {
      const project = await main.addProject(text(args, "path"), text(args, "slug"));
      return result(`Registered ${project.slug}.`, project);
    } });
  pi.registerTool({ name: "merro_list_projects", label: "List Projects", description: "List registered Projects.", parameters: empty,
    async execute() { const projects = await main.listProjects(); return result(JSON.stringify(projects), projects); } });
  pi.registerTool({ name: "merro_discover_issues", label: "Discover issues", description: "Read open GitHub issues in a registered Project.",
    parameters: Type.Object({ project_slug: Type.String() }, { additionalProperties: false }),
    async execute(_id, args) { const issues = await main.discoverIssues(text(args, "project_slug")); return result(JSON.stringify(issues), issues); } });
  pi.registerTool({ name: "merro_propose_objective", label: "Propose plan", description: "Propose the user's Objective. All selected issues in each Project form one ChangeSet, branch, implementation, fresh review, and PR. Only one plan is pending. Ask Approve? and wait. Never start without approval.", parameters: objectiveParameters,
    async execute(_id, args) {
      const input = objectiveInput(args);
      const proposal = await main.proposeObjective(input);
      const names = new Map(proposal.changeSets.map((item) => [item.id, changeName(item)]));
      const plans = proposal.changeSets.map((item) => ({ change: changeName(item), project: item.projectSlug, issues: issueNumbers(item), branch: proposal.branches[item.id] }));
      const settings = (role: "implement" | "review") => {
        const choice = proposal.workerSettings[role];
        return `model: ${choice.model ?? "Pi default"}, thinking: ${choice.thinking ?? "Pi default"}`;
      };
      const workerSettings = { implement: proposal.workerSettings.implement, review: proposal.workerSettings.review };
      const warning = proposal.cycle ? "\nBlocked: dependency cycle." : proposal.unresolved.length ? "\nBlocked: unresolved issue dependencies." : "";
      const message = publicText(`Plan\n\n${plans.map((plan) => `${plan.project}: ${plan.issues.map((number) => `#${number}`).join(" ")}\nChange: ${plan.change}\nBranch: ${plan.branch}`).join("\n\n")}\nDelivery: ${input.delivery === "separate" ? "separate changes" : "one change per Project"}\nPRs: ${plans.length}\nImplementation: one worker per change (${settings("implement")})\nReview: one fresh worker per change (${settings("review")})${warning}\n\nApprove?`, names);
      pi.sendMessage?.({ customType: "merro-proposal", content: message, display: true, details: { plans, workerSettings } });
      return result(message, { plans, workerSettings, relations: proposal.relations.map((edge) => ({ kind: edge.kind, from: names.get(edge.from) ?? "dependency", to: names.get(edge.to) ?? "dependency" })) });
    } });
  pi.registerTool({ name: "merro_start_objective", label: "Approve plan", description: "Approve the single pending plan only after explicit user approval such as 'approve'. Optionally select by semantic change name; never ask for an identifier or repeat the plan parameters.", parameters: Type.Object({ change: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, args) {
      const started = await main.approveObjective(typeof args.change === "string" ? args.change : undefined);
      await main.runPass();
      return result(`Started ${started.changeSets.map(changeName).join(", ")}.\n${started.changeSets.map((item) => `tmux: merro-${item.projectSlug} / impl-${changeName(item)}`).join("\n")}`);
    } });
  pi.registerTool({ name: "merro_continue_change", label: "Continue change", description: "Retry a retryable blocked change after the user fixes its cause. Deterministic unsupported GitHub policy blockers need policy changes and automatic reconciliation, not continuation.",
    parameters: Type.Object({ change: Type.String() }, { additionalProperties: false }),
    async execute(_id, args) { const name = text(args, "change"); await main.continueChangeSet(name); return result(`Continued ${name}.`); } });
  pi.registerTool({ name: "merro_resolve_decision", label: "Resolve decision", description: "Approve or reject a pending merge/conflict decision only after explicit user approval. Select by semantic change name, never by an internal identifier.",
    parameters: Type.Object({ change: Type.String(), approved: Type.Boolean() }, { additionalProperties: false }),
    async execute(_id, args) { const name = text(args, "change"); await main.resolveDecisionForChange(name, args.approved === true); return result(`${name}: decision resolved.`); } });
  pi.registerTool({ name: "merro_restart_change", label: "Restart attempt", description: "After explicit user approval of changed requirements, stop the current attempt and start a fresh implementer. Never send instructions to a running worker.",
    parameters: Type.Object({ change: Type.String(), requirements: Type.String() }, { additionalProperties: false }),
    async execute(_id, args) { const name = text(args, "change"); await main.restartChange(name, text(args, "requirements")); return result(`Fresh implementation started for ${name}.`); } });
  pi.registerTool({ name: "merro_run_pass", label: "Reconcile", description: "Reconcile workers and GitHub; schedule approved work without bypassing decisions.", parameters: empty,
    async execute() { await main.runPass(); return result("Merro reconciled."); } });
  pi.registerTool({ name: "merro_status", label: "Status", description: "Show changes, issues, workers, and pending decisions with semantic names.", parameters: empty,
    async execute() { const snapshot = await main.publicSnapshot(); return result(formatStatus(snapshot), snapshot); } });
}
