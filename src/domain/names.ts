import type { ChangeSet } from "./model.js";

export function semanticSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  if (!slug || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(slug)) {
    throw new Error("Choose a descriptive change name, not an internal identifier.");
  }
  return slug;
}
export function issueNumbers(item: Pick<ChangeSet, "issues">): number[] {
  return item.issues.map((issue) => issue.number);
}
export function changeName(item: Pick<ChangeSet, "slug">): string {
  return item.slug;
}
