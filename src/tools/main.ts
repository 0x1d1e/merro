import { Type } from "typebox";
import { parseObjectiveIssueScopes } from "../domain/objective.js";
import { changeName, issueNumbers } from "../domain/names.js";
import { formatStatus, publicText } from "../runtime/presentation.js";
import type { MainOrchestrator, NamedObjectiveStartInput, ObjectiveStartInput } from "../runtime/main.js";

const empty = Type.Object({}, { additionalProperties: false });
const priority = Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]));
const issueNumbersSchema = Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 });
const legacyObjectiveParameters = Type.Object({
  goal: Type.String(),
  project_slugs: Type.Array(Type.String(), { minItems: 1 }),
  change: Type.String({ description: "Semantic change name, such as plugin-lifecycle-safety. Never a database identifier." }),
  issues: Type.Array(Type.Union([
    Type.Object({ project_slug: Type.String(), numbers: issueNumbersSchema }, { additionalProperties: false }),
    Type.Object({ project_slug: Type.String(), query: Type.Object({ labels: Type.Optional(Type.Array(Type.String())), milestone: Type.Optional(Type.String()) }, { additionalProperties: false }) }, { additionalProperties: false }),
  ]), { minItems: 1 }),
  delivery: Type.Optional(Type.Union([Type.Literal("together"), Type.Literal("separate")])),
  priority,
}, { additionalProperties: false });
const namedObjectiveParameters = Type.Object({
  goal: Type.String(),
  change_sets: Type.Array(Type.Object({
    name: Type.String({ description: "Unique semantic ChangeSet name." }),
    project_slug: Type.String(),
    issues: issueNumbersSchema,
  }, { additionalProperties: false }), { minItems: 1 }),
  relations: Type.Optional(Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("Requires"), Type.Literal("Conflicts")]),
    from: Type.String({ description: "Dependent name for Requires; either name for Conflicts." }),
    to: Type.String({ description: "Prerequisite name for Requires; other name for Conflicts." }),
  }, { additionalProperties: false }))),
  priority,
}, { additionalProperties: false });
const objectiveParameters = Type.Union([legacyObjectiveParameters, namedObjectiveParameters]);

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
function objectiveInput(args: Record<string, unknown>): ObjectiveStartInput | NamedObjectiveStartInput {
  if ("change_sets" in args) {
    if (!Array.isArray(args.change_sets)) throw new Error("change_sets must be an array");
    const changeSets = args.change_sets.map((value) => {
      if (!value || typeof value !== "object") throw new Error("ChangeSet selection must be an object");
      const row = value as Record<string, unknown>;
      if (!Array.isArray(row.issues) || (row.issues as unknown[]).some((number: unknown) => !Number.isSafeInteger(number) || Number(number) < 1)) {
        throw new Error("ChangeSet issues must be positive issue numbers");
      }
      return { name: text(row, "name"), projectSlug: text(row, "project_slug"), issues: row.issues as number[] };
    });
    if (args.relations !== undefined && !Array.isArray(args.relations)) throw new Error("relations must be an array");
    const relations = (args.relations ?? []) as unknown[];
    return {
      goal: text(args, "goal"), changeSets,
      relations: relations.map((value) => {
        if (!value || typeof value !== "object") throw new Error("Relation must be an object");
        const row = value as Record<string, unknown>;
        if (row.kind !== "Requires" && row.kind !== "Conflicts") throw new Error("Relation kind must be Requires or Conflicts");
        return { kind: row.kind, from: text(row, "from"), to: text(row, "to") };
      }),
      ...(args.priority ? { priority: args.priority as NonNullable<ObjectiveStartInput["priority"]> } : {}),
    };
  }
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
  pi.registerTool({ name: "merro_propose_objective", label: "Propose plan", description: "Propose an Objective as named ChangeSets with per-Project issue selections and optional Requires or Conflicts relations. The legacy selection form remains supported. Only one plan is pending. Show the normalized plan, ask Approve? and wait. Never start without approval.", parameters: objectiveParameters,
    async execute(_id, args) {
      const input = objectiveInput(args);
      const proposal = await main.proposeObjective(input);
      const names = new Map(proposal.changeSets.map((item) => [item.id, changeName(item)]));
      for (const [id, name] of Object.entries(proposal.relationNames)) names.set(id, name);
      const plans = proposal.changeSets.map((item) => ({ change: changeName(item), project: item.projectSlug, issues: issueNumbers(item), branch: proposal.branches[item.id] }));
      const plannedIds = new Set(proposal.changeSets.map((item) => item.id));
      const relationLines = new Map<string, string[]>();
      for (const edge of proposal.relations) {
        const from = names.get(edge.from) ?? "dependency";
        const to = names.get(edge.to) ?? "dependency";
        const externalDependent = !plannedIds.has(edge.from) && plannedIds.has(edge.to);
        const owner = externalDependent ? to : from;
        const line = edge.kind === "Requires"
          ? `${externalDependent ? "required by" : "after"} ${externalDependent ? from : to}`
          : `conflicts with ${externalDependent ? from : to}`;
        relationLines.set(owner, [...(relationLines.get(owner) ?? []), line]);
      }
      const relations = proposal.relations.map((edge) => ({ kind: edge.kind, from: names.get(edge.from) ?? "dependency", to: names.get(edge.to) ?? "dependency" }));
      const warning = proposal.cycle ? "\nCannot start: dependencies form a cycle." : proposal.unresolved.length ? "\nCannot start: some issue dependencies are unresolved." : "";
      const named = "changeSets" in input;
      const planText = plans.map((plan) => {
        const relations = (relationLines.get(plan.change) ?? []).map((line) => `\n  ${line}`).join("");
        return named
          ? `${plan.change}\n  ${plan.project} ${plan.issues.map((number) => `#${number}`).join(" ")}${relations}`
          : `${plan.project}: ${plan.issues.map((number) => `#${number}`).join(" ")}\nChange: ${plan.change}${relations}`;
      }).join("\n\n");
      const totals = `${plans.length} change${plans.length === 1 ? "" : "s"} · ${plans.length} pull request${plans.length === 1 ? "" : "s"}`;
      const message = publicText(`Plan\n\n${planText}\n\n${totals}${warning}\n\nApprove?`, names);
      const details = { plans, relations, runnableImmediately: proposal.runnableImmediately };
      pi.sendMessage?.({ customType: "merro-proposal", content: message, display: true, details });
      return result(message, details);
    } });
  pi.registerTool({ name: "merro_start_objective", label: "Approve plan", description: "Approve the single pending plan only after explicit user approval such as 'approve'. Optionally select by semantic change name; never ask for an identifier or repeat the plan parameters.", parameters: Type.Object({ change: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, args) {
      const started = await main.approveObjective(typeof args.change === "string" ? args.change : undefined);
      await main.runPass();
      return result(`Working: ${started.changeSets.map(changeName).join(", ")}.`);
    } });
  pi.registerTool({ name: "merro_retry_change", label: "Retry change", description: "Retry one eligible blocked change after its cause is fixed. Infer the only eligible change when unambiguous; do not retry automatic or GitHub-policy blockers.",
    parameters: Type.Object({ change: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, args) { return result(await main.retryChangeSet(typeof args.change === "string" ? args.change : undefined)); } });
  pi.registerTool({ name: "merro_resolve_decision", label: "Approve or leave open", description: "Approve or leave a pending merge decision only after explicit user approval. Infer a unique decision; approving an already merged change succeeds idempotently.",
    parameters: Type.Object({ change: Type.Optional(Type.String()), approved: Type.Boolean() }, { additionalProperties: false }),
    async execute(_id, args) { return result(await main.resolveDecisionForChange(typeof args.change === "string" ? args.change : undefined, args.approved === true)); } });
  pi.registerTool({ name: "merro_restart_change", label: "Restart attempt", description: "After explicit user approval of changed requirements, stop the current attempt and start a fresh implementer. Never send instructions to a running worker.",
    parameters: Type.Object({ change: Type.String(), requirements: Type.String() }, { additionalProperties: false }),
    async execute(_id, args) { const name = text(args, "change"); await main.restartChange(name, text(args, "requirements")); return result(`Fresh implementation started for ${name}.`); } });
  pi.registerTool({ name: "merro_run_pass", label: "Reconcile", description: "Reconcile workers and GitHub; schedule approved work without bypassing decisions.", parameters: empty,
    async execute() { await main.runPass(); return result("Checked current work."); } });
  pi.registerTool({ name: "merro_status", label: "Status", description: "Show concise user-facing work states, pull requests, CI, and decisions.", parameters: empty,
    async execute() {
      const snapshot = await main.publicSnapshot();
      return result(formatStatus(snapshot), snapshot);
    } });
}
