import type { ChangeSet } from "../domain/model.js";
import type { ImplementSuccessResult, ReviewResult, Verification } from "../protocol/result.js";
import { issueNumbers } from "../domain/names.js";
import { publicText } from "./presentation.js";

/** PR content is a rendering of task intent and reviewed structured data, not activity prose. */
export interface ReviewedChange {
  change: ChangeSet;
  intent: string;
  branch: string;
  implementation: ImplementSuccessResult | null;
  review: ReviewResult;
}

const INTERNAL = /\b(?:[0-9a-f]{40}(?:[0-9a-f]{24})?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b|\bcommit\b.*\b(?:parent|ancestr|directly on)\b|\b(?:worktree|clone path|task_id|reviewed_commit)\b|(?:^|[\s`"'])(?:\/(?:home|tmp|merro|workspace|root)\/|[A-Z]:\\)|\.wt\/|\.merro\/|\bMerro\b|\b(?:AwaitingMerge|PublishBlocked|Publishing|Reviewed)\b|No PR created per task instructions/i;

function productText(value: string): string | null {
  const text = value.trim().replace(/^[-*]\s+/, "");
  if (!text || /[\r\n]/.test(text) || INTERNAL.test(text)) return null;
  return publicText(text);
}

export function normalizedVerification(entries: readonly Verification[]): string {
  const commands = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "command" || entry.exit_code !== 0) continue;
    const command = entry.command.trim();
    // Working directories and manual/reviewer narratives are not PR verification.
    if (!command || /[\r\n]/.test(command) || INTERNAL.test(command)
      || entry.cwd !== "." && entry.cwd !== "/" && command.includes(entry.cwd)) continue;
    commands.add(command);
  }
  return [...commands].map((command) => `- \`${command.replace(/`/g, "\\`")}\``).join("\n") || "- No passing command verification recorded.";
}

export function renderPullRequestContent(input: ReviewedChange): { title: string; body: string; verification: string } {
  const kind = /^(fix|feat|chore)\//.exec(input.branch)?.[1] ?? "chore";
  const intent = productText(input.intent) ?? input.change.slug.replace(/-/g, " ");
  const subject = intent.replace(/^(?:fix|feat|chore)(?:\([^)]*\))?!?:\s*/i, "").replace(/[.!]+$/, "");
  const title = `${kind}: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`.slice(0, 72).trim();
  const changes = [...new Set(input.implementation?.changes?.map(productText).filter((text): text is string => text !== null) ?? [])];
  const summary = (changes.length ? changes : [intent]).map((text) => `- ${text}`).join("\n");
  const verification = normalizedVerification([...(input.implementation?.verification ?? []), ...input.review.verification]);
  const issues = issueNumbers(input.change).map((number) => `Closes #${number}`).join("\n") || "No linked issues.";
  return { title, verification, body: `## Summary\n\n${summary}\n\n## Verification\n\n${verification}\n\n## Issues\n\n${issues}` };
}
