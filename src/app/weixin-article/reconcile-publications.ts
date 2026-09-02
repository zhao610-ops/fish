import type { ArtifactStore } from "@src/core/ports/artifact-store.ts";
import type {
  ContentPublisher,
  PublishResult,
} from "@src/core/ports/content-publisher.ts";
import type { RunStateStore } from "@src/core/ports/run-state-store.ts";

/** 只轮询已受理的发表任务，查询失败留待下次检查，绝不重新提交文章。 */
export async function reconcilePublications(options: {
  artifactStore: ArtifactStore;
  runStateStore: RunStateStore;
  publisher: (result: PublishResult) => ContentPublisher;
  onError: (error: unknown) => void;
}): Promise<void> {
  const { artifactStore, runStateStore } = options;
  // 历史记录不截断，避免长时间审核的任务被新记录挤出轮询范围。
  for (const run of await runStateStore.listRuns(Number.MAX_SAFE_INTEGER)) {
    // 兼容提交结果落盘后、运行状态更新前崩溃的情况。活跃运行暂不介入。
    const staleRunning = run.status === "running" &&
      Date.now() - Date.parse(run.updatedAt) > 5 * 60 * 1000;
    if (
      run.dryRun ||
      (run.status !== "publishing" && run.status !== "failed" && !staleRunning)
    ) continue;
    try {
      const key = artifactStore.createRunKey(
        run.runId,
        "14-publish-result",
        "json",
      );
      const object = await artifactStore.getObject(key);
      if (!object) continue;
      const result = await artifactStore.getJson<PublishResult>(object.ref);
      if (result.mode !== "publish") continue;
      if (
        result.status === "failed" && run.status === "failed" &&
        run.error === (result.reason ?? "微信发表失败")
      ) continue;
      const publisher = options.publisher(result);
      if (!publisher.getPublishStatus) continue;
      const next = result.status === "pending"
        ? await publisher.getPublishStatus(result)
        : result;
      if (next.status === "pending") {
        if (run.status !== "publishing") {
          await runStateStore.updateRun(run.runId, {
            status: "publishing",
            error: undefined,
          });
        }
        continue;
      }
      if (next.status !== "published" && next.status !== "failed") continue;
      const ref = await artifactStore.putJson(key, next, { label: "发表结果" });
      const summary = `${run.summary ?? "文章生成完成"}\n- 发表结果: ${
        next.reason ?? next.status
      }${next.url ? `\n- 文章链接: ${next.url}` : ""}`;
      if (next.status === "failed") {
        await runStateStore.updateRun(run.runId, { summary });
        await runStateStore.failRun(run.runId, next.reason ?? "微信发表失败");
      } else {
        await runStateStore.updateRun(run.runId, { error: undefined });
        await runStateStore.finishRun(run.runId, {
          summary,
          artifacts: [...run.artifacts.filter((item) => item.key !== key), ref],
        });
      }
    } catch (error) {
      options.onError(error);
    }
  }
}
