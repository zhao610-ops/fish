/** 显式预览开关优先；forcePublish 仅保留旧调用未传 dryRun 时的兼容行为。 */
export function resolveArticleDryRun(
  input: { dryRun?: boolean; forcePublish?: boolean },
  defaultDryRun: boolean,
): boolean {
  if (typeof input.dryRun === "boolean") return input.dryRun;
  return input.forcePublish ? false : defaultDryRun;
}
