import { createHash } from "node:crypto";

/** A local path component, never an authoritative WorkItem identity. */
export function workItemPathName(workItemId: string): string {
  const slug = workItemId.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "") || "workitem";
  const hash = createHash("sha256").update(workItemId, "utf8").digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}
