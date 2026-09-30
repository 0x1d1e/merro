import { Type } from "typebox";
import type { ObjectiveStartInput } from "../runtime/main.js";
import type { MainOrchestrator } from "../runtime/main.js";

const projectParameters = Type.Object({
  path: Type.String(),
  slug: Type.String(),
}, { additionalProperties: false });

const projectSlugParameters = Type.Object({
  project_slug: Type.String(),
}, { additionalProperties: false });

const objectiveParameters = Type.Object({
  goal: Type.String(),
  project_slugs: Type.Array(Type.String(), { minItems: 1 }),
  issues: Type.Array(Type.Object({
    project_slug: Type.String(),
    numbers: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
  }), { minItems: 1 }),
  priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")])),
  max_review_rounds: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("unlimited")])),
}, { additionalProperties: false });

const relationParameters = Type.Object({
  relations: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("Requires"), Type.Literal("Conflicts")]),
    from: Type.String(),
    to: Type.String(),
    confidence: Type.Union([Type.Literal("explicit"), Type.Literal("high")]),
    rationale: Type.String(),
    evidence: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const workItemParameters = Type.Object({
  work_item_id: Type.String(),
}, { additionalProperties: false });

const emptyParameters = Type.Object({}, { additionalProperties: false });

interface MainTool {
  name: string;
  label: string;
  description: string;
  parameters: object;
  execute(toolCallId: string, args: Record<string, unknown>): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }>;
}

export interface MainToolAPI {
  registerTool(tool: MainTool): void;
}

function result(text: string, details: unknown = undefined): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text }], details };
}

function stringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be a non-empty string`);
  return value;
}

function stringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value;
}

export function registerMainTools(pi: MainToolAPI, main: MainOrchestrator): void {
  pi.registerTool({
    name: "merro_add_project",
    label: "Register Project",
    description: "Register a local GitHub Project for Merro. Use only after the user identifies the Project and confirms its path and slug.",
    parameters: projectParameters,
    async execute(_id, args) {
      const project = await main.addProject(stringArgument(args, "path"), stringArgument(args, "slug"));
      return result(`Registered Project ${project.slug} at ${project.path} (default branch ${project.defaultBranch}).`, project);
    },
  });

  pi.registerTool({
    name: "merro_list_projects",
    label: "List Projects",
    description: "List Projects already registered in this Merro workspace.",
    parameters: emptyParameters,
    async execute() {
      const projects = await main.listProjects();
      return result(JSON.stringify(projects), projects);
    },
  });

  pi.registerTool({
    name: "merro_discover_issues",
    label: "Discover open issues",
    description: "List open GitHub issues for a registered Project. Do not create or modify issues.",
    parameters: projectSlugParameters,
    async execute(_id, args) {
      const issues = await main.discoverIssues(stringArgument(args, "project_slug"));
      return result(JSON.stringify(issues), issues);
    },
  });

  pi.registerTool({
    name: "merro_start_objective",
    label: "Approve Objective and start work",
    description: "Create an Objective and its selected open-issue WorkItems, then schedule work. Call only after the user explicitly approves the goal, Project scope, selected issues, and proposed relations. This call itself records that approval.",
    parameters: objectiveParameters,
    async execute(_id, args) {
      const goal = stringArgument(args, "goal");
      const projectSlugs = stringArray(args, "project_slugs");
      const rawIssues = args.issues;
      if (!Array.isArray(rawIssues)) throw new Error("issues must be an array");
      const issues = rawIssues.map((entry, index) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`issues[${index}] must be an object`);
        const row = entry as Record<string, unknown>;
        if (typeof row.project_slug !== "string" || !Array.isArray(row.numbers) || row.numbers.some((number) => !Number.isSafeInteger(number) || Number(number) < 1)) {
          throw new Error(`issues[${index}] must include project_slug and positive issue numbers`);
        }
        return { projectSlug: row.project_slug, numbers: row.numbers as number[] };
      });
      const input: ObjectiveStartInput = {
        goal,
        projectSlugs,
        issues,
        ...(args.priority === undefined ? {} : { priority: args.priority as NonNullable<ObjectiveStartInput["priority"]> }),
        ...(args.max_review_rounds === undefined ? {} : { maxReviewRounds: args.max_review_rounds as NonNullable<ObjectiveStartInput["maxReviewRounds"]> }),
      };
      const started = await main.startObjective(input);
      await main.runPass();
      const details = { objective: started.objective, workItems: started.workItems };
      return result(`Objective ${started.objective.id} approved with ${started.workItems.length} WorkItem(s): ${started.workItems.map((item) => item.id).join(", ")}.`, details);
    },
  });

  pi.registerTool({
    name: "merro_update_relations",
    label: "Update WorkItem relations",
    description: "Persist explicit or high-confidence Requires/Conflicts relations between existing WorkItems. Include evidence and rationale; call only for relations inside an approved Objective scope.",
    parameters: relationParameters,
    async execute(_id, args) {
      const relations = args.relations;
      if (!Array.isArray(relations)) throw new Error("relations must be an array");
      await main.updateRelations(relations as Parameters<MainOrchestrator["updateRelations"]>[0]);
      return result(`Updated ${relations.length} active relation(s).`, relations);
    },
  });

  pi.registerTool({
    name: "merro_continue_work_item",
    label: "Continue blocked WorkItem",
    description: "Resume a Blocked WorkItem after the user fixes the cause and explicitly asks to continue.",
    parameters: workItemParameters,
    async execute(_id, args) {
      const id = stringArgument(args, "work_item_id");
      await main.continueWorkItem(id);
      return result(`Continued WorkItem ${id}.`);
    },
  });

  pi.registerTool({
    name: "merro_run_pass",
    label: "Reconcile and schedule",
    description: "Reconcile active Tasks and pull requests, consume valid results, then schedule available WorkItems. Never call to bypass a pending user Decision.",
    parameters: emptyParameters,
    async execute() {
      await main.runPass();
      return result("Merro reconciliation and scheduling pass completed.");
    },
  });

  pi.registerTool({
    name: "merro_status",
    label: "Show Merro state",
    description: "Read the current Projects, Objectives, WorkItems, Tasks, and pending Decisions from Merro's SQLite state.",
    parameters: emptyParameters,
    async execute() {
      const snapshot = await main.statusSnapshot();
      return result(JSON.stringify(snapshot), snapshot);
    },
  });
}
