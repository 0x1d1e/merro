export function assertProjectSlug(slug: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error(`invalid Project slug: ${slug}`);
  }
}
