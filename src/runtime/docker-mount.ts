function csvField(value: string): string {
  return /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Docker --mount parses CSV fields, independently of shell argument quoting. */
export function dockerBindMount(source: string, target: string, options: { readOnly?: boolean } = {}): string[] {
  return ["--mount", ["type=bind", `src=${source}`, `dst=${target}`, ...(options.readOnly ? ["readonly"] : [])]
    .map(csvField).join(",")];
}
