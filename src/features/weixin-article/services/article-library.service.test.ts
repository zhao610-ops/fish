import { assert, assertEquals } from "@std/assert";
import { MemoryArtifactStore } from "@src/core/storage/memory-artifact-store.ts";
import { LocalArtifactStore } from "@src/platform/local/local-artifact-store.ts";
import { ArticleLibraryService } from "./article-library.service.ts";
import type { TranslatedArticle } from "./translation.service.ts";

const article: TranslatedArticle = {
  title: "测试文章",
  html: "<p>完整正文</p>",
  markdown: "完整正文",
  sourceUrl: "https://example.org/article",
  sourceHash: "test-source",
  urlKey: "claims/url",
  contentKey: "claims/content",
  qualityScore: 90,
  auditedAt: new Date().toISOString(),
};

Deno.test("短有效期的文章过期后可在同一天重新备稿，不返回旧的过期库存", async () => {
  const bank = new ArticleLibraryService(
    new MemoryArtifactStore(),
    "a",
    "p",
    "policy",
    1,
  );
  const now = new Date();
  const old = await bank.add(
    article,
    "old",
    new Date(now.getTime() - 2 * 3600000),
  );
  const fresh = await bank.add(article, "new", now);
  assert(old.id !== fresh.id);
  const entries = await bank.list(now);
  assertEquals(entries.filter((entry) => entry.state === "ready").length, 1);
  assertEquals(
    entries.find((entry) => entry.state === "ready")!.preparedRunId,
    "new",
  );
});

Deno.test("文章库存持久化、隔离方案和账号，策略变更和过期不放行", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = new LocalArtifactStore(directory);
    const bank = new ArticleLibraryService(
      store,
      "account-a",
      "profile-a",
      "policy-a",
      24,
    );
    const now = new Date();
    await bank.add(article, "prepare-one", now);
    await bank.add(article, "prepare-two", now);
    const restored = new ArticleLibraryService(
      new LocalArtifactStore(directory),
      "account-a",
      "profile-a",
      "policy-a",
      24,
    );
    assertEquals((await restored.list()).length, 1);
    assertEquals((await restored.list())[0].state, "ready");
    assertEquals(
      (await restored.list(new Date(now.getTime() + 25 * 3600000)))[0].state,
      "expired",
    );
    assertEquals(
      (await new ArticleLibraryService(
        store,
        "account-a",
        "profile-a",
        "policy-b",
        24,
      ).list())[0].state,
      "policy-changed",
    );
    assertEquals(
      (await new ArticleLibraryService(
        store,
        "account-b",
        "profile-a",
        "policy-a",
        24,
      ).list()).length,
      0,
    );
    assertEquals(
      (await new ArticleLibraryService(
        store,
        "account-a",
        "profile-b",
        "policy-a",
        24,
      ).list()).length,
      0,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("并发取稿仅一份占位成功，未知发送结果不自动回队列", async () => {
  const store = new MemoryArtifactStore();
  const bank = new ArticleLibraryService(store, "a", "p", "policy", 24);
  const entry = await bank.add(article, "prepare");
  const results = await Promise.all([
    bank.reserve(entry, "publish-a"),
    bank.reserve(entry, "publish-b"),
  ]);
  assertEquals(results.filter(Boolean).length, 1);
  assertEquals((await bank.list())[0].state, "reserved");
  assertEquals(await bank.reserve(entry, "publish-c"), false);
  const runId = (await bank.list())[0].publishRunId!;
  await store.putJson(store.createRunKey(runId, "14-publish-result", "json"), {
    status: "published",
    url: "https://mp.weixin.qq.com/s/example",
  });
  const final = (await bank.list())[0];
  assertEquals(final.state, "published");
  assert(final.url);
});
