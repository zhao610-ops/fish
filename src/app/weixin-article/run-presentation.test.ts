import { assertEquals } from "@std/assert";
import { MemoryArtifactStore } from "@src/core/storage/memory-artifact-store.ts";
import { MemoryRunStateStore } from "@src/core/storage/memory-run-state-store.ts";
import { presentArticleRun } from "./run-presentation.ts";
import { syncMatrixParentRun } from "./matrix-run-summary.ts";

Deno.test("所有子任务都跳过时批次也标为跳过，并保留完成时间", async () => {
  const runs = new MemoryRunStateStore();
  await runs.startRun({
    runId: "parent",
    runKind: "matrix-parent",
    mode: "local",
    dryRun: true,
    trigger: "manual",
  });
  await runs.startRun({
    runId: "child",
    runKind: "matrix-child",
    parentRunId: "parent",
    mode: "local",
    dryRun: true,
    trigger: "manual",
  });
  await runs.finishRun("child", { status: "skipped" });
  const result = await syncMatrixParentRun(runs, "parent");
  assertEquals(result?.skipped, 1);
  assertEquals((await runs.getRun("parent"))?.status, "skipped");
  assertEquals(typeof (await runs.getRun("parent"))?.finishedAt, "string");
});

Deno.test("历史成功记录按发布产物展示跳过，不改写历史，也不误报预览或发表结果", async () => {
  const runs = new MemoryRunStateStore();
  const artifacts = new MemoryArtifactStore();
  for (const status of ["blocked", "draft", "published"]) {
    await runs.startRun({
      runId: status,
      mode: "local",
      dryRun: true,
      trigger: "manual",
    });
    const ref = await artifacts.putJson(
      `runs/${status}/14-publish-result.json`,
      { status },
    );
    await runs.finishRun(status, { artifacts: [ref] });
    const run = (await runs.getRun(status))!;
    assertEquals(
      (await presentArticleRun(run, artifacts)).status,
      status === "blocked" ? "skipped" : "succeeded",
    );
    assertEquals((await runs.getRun(status))?.status, "succeeded");
  }
  const run = (await runs.getRun("blocked"))!;
  assertEquals(
    (await presentArticleRun(run, new MemoryArtifactStore())).status,
    "succeeded",
  );
  await runs.finishRun("blocked", { status: "skipped" });
  assertEquals((await runs.getRun("blocked"))?.status, "skipped");
});
