import { assertEquals } from "@std/assert";
import { MemoryRunStateStore } from "@src/core/storage/memory-run-state-store.ts";
import { MemoryArtifactStore } from "@src/core/storage/memory-artifact-store.ts";
import type {
  ContentPublisher,
  PublishResult,
} from "@src/core/ports/content-publisher.ts";
import { reconcilePublications } from "./reconcile-publications.ts";

async function fixture() {
  const runStateStore = new MemoryRunStateStore();
  const artifactStore = new MemoryArtifactStore();
  await runStateStore.startRun({
    runId: "run",
    mode: "local",
    dryRun: false,
    trigger: "cron",
  });
  await runStateStore.updateRun("run", {
    status: "publishing",
    summary: "文章已生成",
  });
  const ref = await artifactStore.putJson(
    "runs/run/14-publish-result.json",
    {
      publishId: "publication",
      status: "pending",
      mode: "publish",
      platform: "weixin",
      publishedAt: new Date(),
    } satisfies PublishResult,
  );
  return { runStateStore, artifactStore, ref };
}

Deno.test("轮询失败后下轮继续查询，成功保存链接，已完成任务不再查询", async () => {
  const context = await fixture();
  let checks = 0;
  let errors = 0;
  const publisher: ContentPublisher = {
    uploadImage: async () => {
      throw new Error("不能上传");
    },
    publishArticle: async () => {
      throw new Error("不能重复发表");
    },
    getPublishStatus: async (result) => {
      checks++;
      if (checks === 1) throw new Error("模拟网络异常");
      return {
        ...result,
        status: "published",
        url: "https://mp.weixin.qq.com/s/article",
        reason: "文章已公开发表",
      };
    },
  };
  const options = {
    ...context,
    publisher: () => publisher,
    onError: () => {
      errors++;
    },
  };
  await reconcilePublications(options);
  assertEquals(
    (await context.runStateStore.getRun("run"))?.status,
    "publishing",
  );
  await reconcilePublications(options);
  assertEquals(
    (await context.runStateStore.getRun("run"))?.status,
    "succeeded",
  );
  assertEquals(
    (await context.artifactStore.getJson<PublishResult>(context.ref)).url,
    "https://mp.weixin.qq.com/s/article",
  );
  await reconcilePublications(options);
  assertEquals(checks, 2);
  assertEquals(errors, 1);
});

Deno.test("微信审核拒绝会标记失败，不会重新提交", async () => {
  const context = await fixture();
  await reconcilePublications({
    ...context,
    onError: () => {},
    publisher: () => ({
      uploadImage: async () => "",
      publishArticle: async () => {
        throw new Error("不得重发");
      },
      getPublishStatus: async (result) => ({
        ...result,
        status: "failed",
        reason: "平台审核不通过",
      }),
    }),
  });
  assertEquals((await context.runStateStore.getRun("run"))?.status, "failed");
  assertEquals(
    (await context.runStateStore.getRun("run"))?.error,
    "平台审核不通过",
  );
});

Deno.test("结果已保存但运行状态尚未更新时可继续完成，不再请求微信", async () => {
  const context = await fixture();
  const result = await context.artifactStore.getJson<PublishResult>(
    context.ref,
  );
  await context.artifactStore.putJson(context.ref.key, {
    ...result,
    status: "published",
    url: "https://mp.weixin.qq.com/s/article",
  });
  await reconcilePublications({
    ...context,
    onError: () => {},
    publisher: () => ({
      uploadImage: async () => "",
      publishArticle: async () => {
        throw new Error("不得重发");
      },
      getPublishStatus: async () => {
        throw new Error("不得重查");
      },
    }),
  });
  assertEquals(
    (await context.runStateStore.getRun("run"))?.status,
    "succeeded",
  );
});

Deno.test("提交结果已落盘但状态更新中断时恢复查询，不重复发表", async () => {
  for (const status of ["failed", "running"] as const) {
    const context = await fixture();
    await context.runStateStore.updateRun("run", {
      status,
      error: "状态更新中断",
    });
    if (status === "running") {
      const original = context.runStateStore.listRuns.bind(
        context.runStateStore,
      );
      context.runStateStore.listRuns = async (limit) =>
        (await original(limit)).map((run) => ({
          ...run,
          updatedAt: "2020-01-01T00:00:00Z",
        }));
    }
    await reconcilePublications({
      ...context,
      onError: () => {},
      publisher: () => ({
        uploadImage: async () => "",
        publishArticle: async () => {
          throw new Error("不得重发");
        },
        getPublishStatus: async (result) => ({
          ...result,
          status: "published",
          url: "https://mp.weixin.qq.com/s/article",
        }),
      }),
    });
    assertEquals(
      (await context.runStateStore.getRun("run"))?.status,
      "succeeded",
    );
    assertEquals((await context.runStateStore.getRun("run"))?.error, undefined);
  }
});
