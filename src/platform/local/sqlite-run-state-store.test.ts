import { assertEquals } from "@std/assert";
import { SQLiteRunStateStore } from "./sqlite-run-state-store.ts";
import { LocalJsonRunStateStore } from "./local-json-run-state-store.ts";

Deno.test("多个存储实例更新不同运行和步骤时不会覆盖记录，重建实例可恢复", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const stores = [
      new SQLiteRunStateStore(directory),
      new SQLiteRunStateStore(directory),
    ];
    await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      const store = stores[index % 2];
      const runId = `run-${index}`;
      await store.startRun({
        runId,
        mode: "local",
        dryRun: false,
        trigger: "cron",
      });
      await store.startStep(runId, "生成");
      await store.finishStep(runId, "生成");
      await store.updateRun(runId, { status: "publishing" });
    }));
    const fresh = new SQLiteRunStateStore(directory);
    assertEquals((await fresh.listRuns()).length, 10);
    for (const run of await fresh.listRuns()) {
      assertEquals(run.status, "publishing");
      assertEquals(
        (await fresh.getRun(run.runId))?.steps[0].status,
        "succeeded",
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("旧 JSON 记录只迁移一次，保留原文件且不覆盖后续状态", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const old = new LocalJsonRunStateStore(directory);
    await old.startRun({
      runId: "old",
      mode: "local",
      dryRun: true,
      trigger: "manual",
    });
    await old.startStep("old", "旧步骤");
    await old.finishStep("old", "旧步骤");
    const store = new SQLiteRunStateStore(directory);
    assertEquals((await store.getRun("old"))?.steps.length, 1);
    await store.finishRun("old");
    assertEquals(
      (await new SQLiteRunStateStore(directory).getRun("old"))?.status,
      "succeeded",
    );
    assertEquals((await old.getRun("old"))?.status, "running");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
