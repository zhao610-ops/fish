import type { ArtifactStore } from "@src/core/ports/artifact-store.ts";
import type { ArticleRunRecord } from "@src/core/ports/run-state-store.ts";

/** 兼容旧版把跳过记成成功的记录；只读展示，不改写历史数据。 */
export async function presentArticleRun<T extends ArticleRunRecord>(
  run: T,
  artifacts: ArtifactStore,
): Promise<T> {
  if (run.status !== "succeeded") return run;
  const ref = run.artifacts.find((item) =>
    item.key.endsWith("/14-publish-result.json")
  );
  if (!ref) return run;
  try {
    const result = await artifacts.getJson<{ status?: string }>(ref);
    return result?.status === "blocked" ? { ...run, status: "skipped" } : run;
  } catch {
    // 旧产物缺失时仍可浏览运行记录，不猜测发布结论。
    return run;
  }
}
