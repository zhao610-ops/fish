import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { WeixinArticleWorkflow } from "./workflow.ts";
import type { WeixinArticleDependencies } from "./dependencies.ts";
import { ArticleTranslationService } from "./services/translation.service.ts";
import { WeixinArticleDryRunOutputService } from "./services/dry-run-output.service.ts";
import { MemoryArtifactStore } from "@src/core/storage/memory-artifact-store.ts";
import { MemoryRunStateStore } from "@src/core/storage/memory-run-state-store.ts";
import { NoopEditorialMemoryStore } from "@src/core/ports/editorial-memory-store.ts";
import type { LLMProvider } from "@src/core/ports/llm.ts";
import type {
  PublishArticleRequest,
  PublishResult,
} from "@src/core/ports/content-publisher.ts";
import type { WorkflowStepContext } from "@src/core/workflow/workflow-runtime.ts";
import { resolveTrendPublishConfig } from "@src/utils/config/define-config.ts";
import type { TranslationPolicy } from "./domain/translation-policy.ts";

const step: WorkflowStepContext = {
  async do(_name, optionsOrFn, fn) {
    return await (typeof optionsOrFn === "function" ? optionsOrFn : fn!)();
  },
  async sleep() {},
};

function harness(
  options: {
    policy?: Partial<TranslationPolicy>;
    block?: boolean;
    publishError?: boolean;
    noService?: boolean;
    contentMode?: "translation" | "editorial-preview";
  } = {},
) {
  const config = resolveTrendPublishConfig({
    features: {
      article: {
        translation: {
          coverMediaId: "self-owned",
          ...options.policy,
        },
      },
    },
  });
  const store = new MemoryArtifactStore();
  const runs = new MemoryRunStateStore();
  const published: PublishArticleRequest[] = [];
  let ipChecks = 0;
  let scrapes = 0;
  const source = {
    id: "a",
    title: "Coding tips",
    content: "Useful programming techniques and practical examples.\n".repeat(
      10,
    ),
    url: "https://example.org/a",
    publishDate: "",
    metadata: { detailFetched: true },
  };
  const llm: LLMProvider = {
    async initialize() {},
    async refresh() {},
    setModel() {},
    async createChatCompletion(messages) {
      const { stage, data } = JSON.parse(messages[1].content);
      const result = stage === "忠实翻译"
        ? {
          text: data.source.length < 100
            ? "编程技巧"
            : "实用编程技术和案例。".repeat(10),
        }
        : stage === "译文对照核验"
        ? {
          faithful: true,
          complete: true,
          identifiersPreserved: true,
          chinese: true,
          reason: "一致",
        }
        : {
          decision: options.block ? "block" : "allow",
          reason: "测试结论",
          complete: true,
          language: "en",
          withinAllowedTopics: true,
          qualityScore: 99,
        };
      return {
        choices: [{
          finish_reason: "stop",
          message: {
            content: stage === "忠实翻译"
              ? (result as { text: string }).text
              : JSON.stringify(result),
          },
        }],
      };
    },
  };
  const forbiddenLegacy = new Proxy({}, {
    get() {
      throw new Error("译刊不得调用旧摘要、组稿或配图链路");
    },
  });
  const dependencies = {
    translationService: options.noService
      ? undefined
      : new ArticleTranslationService(
        config.features.article.translation,
        llm,
        { fetchFullArticle: async () => source },
        store,
        "weixin-app-id",
      ),
    publisher: {
      async validateIpWhitelist() {
        ipChecks++;
        return true;
      },
      async publishArticle(
        request: PublishArticleRequest,
      ): Promise<PublishResult> {
        published.push(request);
        if (options.publishError) throw new Error("模拟微信提交超时");
        return {
          publishId: "queued",
          platform: "weixin",
          status: "pending",
          publishedAt: new Date(),
          mode: request.mode,
        };
      },
    },
    notifier: {
      async info() {},
      async warning() {},
      async error() {},
      async success() {},
    },
    scrapeService: {
      async loadSources() {
        return { sources: [], totalSources: 1 };
      },
      async scrapeAllDetailed() {
        scrapes++;
        return {
          contents: [source],
          health: {
            generatedAt: "",
            totalSources: 1,
            succeeded: 1,
            failed: 0,
            empty: 0,
            totalArticles: 1,
            records: [],
          },
        };
      },
    },
    renderService: {
      setUploadContentImages() {},
      setGenerateContentImages() {},
    },
    dedupService: forbiddenLegacy,
    processService: forbiddenLegacy,
    coverService: forbiddenLegacy,
    dryRunOutputService: new WeixinArticleDryRunOutputService(store),
    runtime: {
      artifactStore: store,
      runStateStore: runs,
      editorialMemoryStore: new NoopEditorialMemoryStore(),
      mode: "local",
    },
    config: {
      contentMode: options.contentMode ?? "translation",
      dryRun: true,
      publishMode: "publish",
      qualityGate: {
        ...config.features.article.qualityGate,
        enabled: false,
        forcePublish: true,
        allowForcePublish: true,
      },
    },
  } as unknown as WeixinArticleDependencies;
  const workflow = new WeixinArticleWorkflow({
    id: "translation",
    name: "译刊",
  }, dependencies);
  const run = (
    id: string,
    dryRun: boolean,
    extra: {
      articleAction?: "prepare" | "publish-next";
      libraryArticleId?: string;
      publishMode?: "draft" | "publish";
    } = {},
  ) =>
    workflow.run({
      id,
      timestamp: Date.now(),
      payload: { runId: id, dryRun, forcePublish: true, ...extra },
    }, step);
  const result = async (id: string) => {
    const value = await store.getObject(
      store.createRunKey(id, "14-publish-result", "json"),
    );
    return value
      ? JSON.parse(new TextDecoder().decode(value.body)) as PublishResult
      : undefined;
  };
  return {
    run,
    runs,
    store,
    published,
    result,
    ipChecks: () => ipChecks,
    scrapes: () => scrapes,
    library: () => dependencies.translationService!.library(),
  };
}

Deno.test("提前备稿仅入库，正式发送从库存取完整原稿且不重复抓取", async () => {
  const h = harness();
  await h.run("prepare", false, { articleAction: "prepare" });
  assertEquals(h.ipChecks(), 0);
  assertEquals(h.published.length, 0);
  const library = await h.library();
  const entry = (await library.list())[0];
  assertEquals(entry.state, "ready");
  assertStringIncludes(
    (await h.runs.getRun("prepare"))!.summary!,
    "已入库待发",
  );
  await h.run("send", false, {
    articleAction: "publish-next",
    libraryArticleId: entry.id,
    publishMode: "publish",
  });
  assertEquals(h.scrapes(), 1);
  assertEquals(h.published.length, 1);
  assertEquals(h.published[0].content, entry.article.html);
  assertEquals(h.published[0].mode, "publish");
  assertEquals((await library.list())[0].state, "reserved");
  await h.run("send-again", false, {
    articleAction: "publish-next",
    libraryArticleId: entry.id,
  });
  assertEquals(h.published.length, 1);
  assertEquals((await h.runs.getRun("send-again"))!.status, "skipped");
});

Deno.test("库存预览不占位，空库存不会临时抓取另一篇发表", async () => {
  const h = harness();
  await h.run("empty", false, { articleAction: "publish-next" });
  assertEquals(h.scrapes(), 0);
  assertEquals(h.published.length, 0);
  await h.run("prepare", true, { articleAction: "prepare" });
  await h.run("bank-preview", true, { articleAction: "publish-next" });
  assertEquals((await (await h.library()).list())[0].state, "ready");
  assertEquals(h.published.length, 0);
});

Deno.test("库存发送前复查不能绕过新的安全拒绝", async () => {
  const options = { block: false };
  const h = harness(options);
  await h.run("prepare", true, { articleAction: "prepare" });
  options.block = true;
  await assertRejects(() =>
    h.run("send", false, { articleAction: "publish-next" })
  );
  assertEquals(h.published.length, 0);
  assertEquals((await (await h.library()).list())[0].state, "blocked");
});

Deno.test("译刊预览输出全文，不连接微信，不调用旧摘要链路", async () => {
  const h = harness();
  await h.run("preview", true);
  assertEquals(h.ipChecks(), 0);
  assertEquals(h.published.length, 0);
  assertEquals((await h.runs.getRun("preview"))?.status, "succeeded");
  const result = await h.result("preview");
  assertEquals(result?.publishId, "dry-run");
  assert(await h.store.getObject(result!.url!));
  assert(
    (await h.runs.getRun("preview"))?.artifacts.some((ref) =>
      ref.key.includes("source-review-")
    ),
  );
});

Deno.test("无人工确认配置的译刊只提交一次并保持等待状态，不把受理当成功", async () => {
  const h = harness();
  await h.run("publish", false);
  assertEquals(h.published.length, 1);
  assertEquals(h.published[0].mode, "publish");
  assertEquals(h.published[0].coverMediaId, "self-owned");
  assertStringIncludes(h.published[0].content, "来源：");
  assertEquals(h.published[0].content.includes("原作者："), false);
  assertEquals((await h.runs.getRun("publish"))?.status, "publishing");
  assertEquals((await h.result("publish"))?.status, "pending");
  await h.run("duplicate", false);
  assertEquals(h.published.length, 1);
  assertEquals((await h.result("duplicate"))?.status, "blocked");
});

Deno.test("强制发布和关闭旧质量门禁不能绕过翻译风险检查", async () => {
  const h = harness({ block: true });
  await h.run("blocked", false);
  assertEquals(h.published.length, 0);
  assertEquals((await h.result("blocked"))?.status, "blocked");
  assertEquals((await h.runs.getRun("blocked"))?.status, "skipped");
});

Deno.test("真实发送前检查封面，缺失服务不能退回摘要", async () => {
  for (
    const options of [
      { policy: { coverMediaId: "" } },
      { noService: true },
      { contentMode: "editorial-preview" as const },
    ]
  ) {
    const h = harness(options);
    await assertRejects(() => h.run("preflight", false));
    assertEquals(h.ipChecks(), 0);
    assertEquals(h.published.length, 0);
    assertEquals((await h.runs.getRun("preflight"))?.status, "failed");
  }
});

Deno.test("发送超时保留意图和占位，新任务也不得自动重发", async () => {
  const h = harness({ publishError: true });
  await assertRejects(() => h.run("timeout", false));
  assert(
    await h.store.getObject(
      h.store.createRunKey("timeout", "14-publish-intent", "json"),
    ),
  );
  await h.run("retry", false);
  assertEquals(h.published.length, 1);
  assertEquals((await h.result("retry"))?.status, "blocked");
});
