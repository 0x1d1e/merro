import { semanticSlug } from "../domain/names.js";

/** Filesystem identity is the persisted semantic ChangeSet name. */
export function changeSetPathName(slug: string): string {
  return semanticSlug(slug);
}
