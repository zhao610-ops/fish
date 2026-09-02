import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { ChatMessage, LLMProvider } from "@src/core/ports/llm.ts";
import type { ScrapedContent } from "@src/core/ports/content-scraper.ts";
import { MemoryArtifactStore } from "@src/core/storage/memory-artifact-store.ts";
import {
  findTranslationGrant,
  REQUIRED_BLOCKED_TOPICS,
  resolveTranslationPolicy,
  safeSourceUrl,
  type TranslationPolicy,
  type TranslationSourceGrant,
} from "../domain/translation-policy.ts";
import {
  ArticleTranslationService,
  assertPreservedLiterals,
  renderTranslation,
  splitTranslationChunks,
} from "./translation.service.ts";

const grant: TranslationSourceGrant = {
  id: "test",
  url: "https://example.org/tutorials/",
  match: "prefix",
  author: "测试作者",
  license: "permission",
  evidenceUrl: "https://example.org/permission",
  confirmed: true,
};
const source: ScrapedContent = {
  id: "article",
  title: "Developer workflow",
  content:
    "A useful workflow improves developer productivity and keeps the code readable.\n\n"
      .repeat(5),
  url: "https://example.org/tutorials/one",
  publishDate: "2026-09-01",
  metadata: { detailFetched: true },
};

function createHarness(options: {
  policy?: Partial<TranslationPolicy>;
  reply?: (stage: string, data: Record<string, string>) => unknown;
  fetch?: (value: ScrapedContent) => Promise<ScrapedContent>;
  finishReason?: string;
  store?: MemoryArtifactStore;
  scope?: string;
} = {}) {
  const calls: {
    stage: string;
    data: Record<string, string>;
    messages: ChatMessage[];
  }[] = [];
  let fetches = 0;
  const llm: LLMProvider = {
    initialize: async () => {},
    refresh: async () => {},
    setModel: () => {},
    createChatCompletion: async (messages) => {
      const { stage, data } = JSON.parse(messages[1].content);
      calls.push({ stage, data, messages });
      let value = options.reply?.(stage, data);
      if (value === undefined) {
        if (stage === "原文安全与完整性检查") {
          value = {
            decision: "allow",
            reason: "测试通过",
            complete: true,
            language: "en",
            withinAllowedTopics: true,
            qualityScore: 90,
          };
        } else if (stage === "忠实翻译") {
          value = {
            text: data.source.length < 100
              ? "开发者工作流"
              : "有效的工作流能提高开发者效率，保持代码可读。\n\n".repeat(5),
          };
        } else if (stage === "译文对照核验") {
          value = {
            faithful: true,
            complete: true,
            identifiersPreserved: true,
            chinese: true,
            reason: "逐句一致",
          };
        } else value = { decision: "allow", reason: "主题合格" };
      }
      return {
        choices: [{
          finish_reason: options.finishReason ?? "stop",
          message: {
            content: typeof value === "string" ? value : JSON.stringify(value),
          },
        }],
      };
    },
  };
  const store = options.store ?? new MemoryArtifactStore();
  const policy = resolveTranslationPolicy({
    grants: [grant],
    coverMediaId: "own-cover",
    platformDisclosureConfirmed: true,
    ...options.policy,
  });
  const service = new ArticleTranslationService(
    policy,
    llm,
    {
      fetchFullArticle: async (value) => {
        fetches++;
        return options.fetch
          ? await options.fetch(value)
          : { ...source, url: value.url };
      },
    },
    store,
    options.scope ?? "account-one",
  );
  return { service, store, calls, fetches: () => fetches };
}

Deno.test("授权按同域目录边界匹配，不能伪装子域或路径", () => {
  const policy = resolveTranslationPolicy({
    grants: [grant],
    blockedTopics: [],
  });
  assertEquals(policy.blockedTopics, REQUIRED_BLOCKED_TOPICS);
  assertEquals(findTranslationGrant(policy, source.url).id, "test");
  for (
    const url of [
      "https://example.org.evil.org/tutorials/one",
      "https://example.org/tutorials-other/one",
      "https://example.org/other/one",
    ]
  ) assertThrows(() => findTranslationGrant(policy, url));
  for (
    const url of [
      "http://example.org/a",
      "https://127.0.0.1/a",
      "https://foo.local/a",
      "https://user:secret@example.org/a",
      "https://example.org/a%2fb",
    ]
  ) assertThrows(() => safeSourceUrl(url));
  assertThrows(() => resolveTranslationPolicy({ allowedTopics: [] }));
  assertThrows(() =>
    resolveTranslationPolicy({
      grants: [{ ...grant, url: "https://example.org/tutorials/?all=true" }],
    })
  );
});

Deno.test("精确授权区分查询参数，未确认或过期授权拒绝", () => {
  const policy = resolveTranslationPolicy({
    grants: [{ ...grant, match: "exact", url: source.url }],
  });
  assertEquals(
    findTranslationGrant(policy, `${source.url}#section`).id,
    "test",
  );
  assertThrows(() => findTranslationGrant(policy, `${source.url}?v=other`));
  assertThrows(() =>
    findTranslationGrant(
      resolveTranslationPolicy({ grants: [{ ...grant, confirmed: false }] }),
      source.url,
    )
  );
  assertThrows(() =>
    findTranslationGrant(
      resolveTranslationPolicy({
        grants: [{ ...grant, expiresAt: "2000-01-01" }],
      }),
      source.url,
    )
  );
});

Deno.test("无授权候选不会抓取详情或调用模型", async () => {
  const h = createHarness({ policy: { grants: [] } });
  const result = await h.service.select([source], "no-grant");
  assertEquals(result.article, undefined);
  assertEquals(h.fetches(), 0);
  assertEquals(h.calls.length, 0);
  assertEquals(result.rejected.length, 1);
});

Deno.test("详情失败、错误地址与摘要均拒绝，不能回退已有正文", async () => {
  for (
    const fetch of [
      async () => {
        throw new Error("详情抓取失败");
      },
      async () => ({ ...source, metadata: {} }),
      async () => ({ ...source, url: "https://example.org/tutorials/other" }),
      async () => ({ ...source, content: "短摘要" }),
    ]
  ) {
    const h = createHarness({ fetch });
    assertEquals(
      (await h.service.select([source], crypto.randomUUID())).article,
      undefined,
    );
    assertEquals(h.calls.length, 0);
  }
});

Deno.test("原文尾部完整参与审核，不确定就拒绝翻译", async () => {
  const longSource = {
    ...source,
    content: "Useful tutorial text.\n".repeat(900) + "政治内容在文章结尾",
  };
  const h = createHarness({
    fetch: async () => longSource,
    reply: (stage) =>
      stage === "原文安全与完整性检查"
        ? {
          decision: "uncertain",
          reason: "结尾涉及政治",
          complete: true,
          language: "en",
          withinAllowedTopics: true,
          qualityScore: 100,
        }
        : undefined,
  });
  assertEquals((await h.service.select([source], "tail")).article, undefined);
  assertEquals(h.calls.length, 1);
  assertStringIncludes(h.calls[0].data.content, "政治内容在文章结尾");
});

Deno.test("模型无效 JSON 或输出截断都不能放行", async () => {
  for (
    const options of [{ reply: () => "不是 JSON" }, { finishReason: "length" }]
  ) {
    const h = createHarness(options);
    assertEquals(
      (await h.service.select([source], crypto.randomUUID())).article,
      undefined,
    );
    assertEquals(h.calls.length, 1);
  }
});

Deno.test("译文核对失败及成稿安全拒绝不能兜底发布", async () => {
  for (const failedStage of ["译文对照核验", "成稿安全检查"]) {
    const h = createHarness({
      reply: (stage) =>
        stage === failedStage
          ? (stage === "译文对照核验"
            ? {
              faithful: false,
              complete: true,
              identifiersPreserved: true,
              chinese: true,
              reason: "遗漏事实",
            }
            : { decision: "block", reason: "译文涉及风险主题" })
          : undefined,
    });
    const result = await h.service.select([source], crypto.randomUUID());
    assertEquals(result.article, undefined);
    assertEquals(result.rejected[0].stage, "翻译或成稿检查");
  }
});

Deno.test("数字与行内代码必须完全保留，代码围栏不交给模型改写", () => {
  assertPreservedLiterals(
    "[Guide](https://example.org/guide)",
    "[指南](https://example.org/guide)",
  );
  assertThrows(() =>
    assertPreservedLiterals(
      "[Guide](https://example.org/guide)",
      "[指南](https://evil.org/guide)",
    )
  );
  assertPreservedLiterals("Version 2.4 uses `foo()`", "版本 2.4 使用 `foo()`");
  assertThrows(() => assertPreservedLiterals("Version 2.4", "版本 2.5"));
  assertThrows(() => assertPreservedLiterals("Use `foo()`", "使用 `bar()`"));
  const code = "```ts\nconst x = 42;\n```";
  assertEquals(splitTranslationChunks(`Start\n${code}\nEnd`, 500), [
    { text: "Start", code: false },
    { text: code, code: true },
    { text: "End", code: false },
  ]);
  assertThrows(() => splitTranslationChunks("```ts\nincomplete", 500));
  assertThrows(() => splitTranslationChunks("x".repeat(501), 500));
});

Deno.test("成稿去除图片和不可信链接，转义 HTML 并保留来源署名", () => {
  const html = renderTranslation(
    "译文",
    '<script>alert("x")</script>\n\n![图](https://evil.org/image.png)\n\n[坏链接](javascript:alert)\n\n<img src=x onerror=alert(1)>',
    "Original",
    source.url,
    grant,
  );
  assertEquals(/<script|<img|href="javascript:/i.test(html), false);
  assertStringIncludes(html, "测试作者");
  assertStringIncludes(html, source.url);
  assertStringIncludes(html, "Microsoft YaHei");
  const linked = renderTranslation(
    "标题",
    "[指南](https://example.org/guide) 和 `<script>`",
    "Original",
    source.url,
    grant,
  );
  assertStringIncludes(linked, 'href="https://example.org/guide"');
  assertEquals(linked.includes("<script>"), false);
});

Deno.test("成功翻译保留各项产物，预览不占用发送记录", async () => {
  const h = createHarness();
  const result = await h.service.select([source], "preview");
  assert(result.article);
  assertStringIncludes(result.article.html, "开发者工作流");
  assertEquals(await h.store.getObject(result.article.urlKey), null);
  assert(result.artifacts.some((ref) => ref.key.includes("source-review-")));
  assert(
    result.artifacts.some((ref) =>
      ref.key.includes("translation-final-review-")
    ),
  );
  assert(
    h.calls.every((call) => call.messages[0].content.includes("不可信资料")),
  );
});

Deno.test("候选按质量排序且每轮最多选择一篇", async () => {
  const h = createHarness({
    reply: (stage, data) =>
      stage === "原文安全与完整性检查"
        ? {
          decision: "allow",
          reason: "质量评分",
          complete: true,
          language: "en",
          withinAllowedTopics: true,
          qualityScore: data.url.endsWith("two") ? 99 : 81,
        }
        : undefined,
  });
  const result = await h.service.select([source, {
    ...source,
    url: "https://example.org/tutorials/two",
  }], "ranking");
  assertEquals(result.article?.sourceUrl, "https://example.org/tutorials/two");
  assertEquals(
    h.calls.filter((call) => call.stage === "成稿安全检查").length,
    1,
  );
});

Deno.test("原子占位只允许一个任务，同正文另一地址也阻止重发", async () => {
  const h = createHarness();
  const result = await h.service.select([source], "first");
  assert(result.article);
  const attempts = await Promise.allSettled([
    h.service.reserve(result.article, "a"),
    h.service.reserve(result.article, "b"),
  ]);
  assertEquals(
    attempts.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assertEquals((await h.service.select([source], "again")).article, undefined);
  const copied = await h.service.select([{
    ...source,
    url: "https://example.org/tutorials/copy",
  }], "copy");
  assertEquals(copied.article, undefined);
  assertStringIncludes(copied.rejected[0].reason, "相同正文");
  const other = createHarness({ store: h.store, scope: "account-two" });
  assert((await other.service.select([source], "other-account")).article);
});

Deno.test("未配置封面、AI 标识或原子存储都不能真实发送", async () => {
  for (
    const policy of [{ coverMediaId: "" }, {
      platformDisclosureConfirmed: false,
    }]
  ) {
    assertThrows(() =>
      createHarness({ policy }).service.assertPublicationReady()
    );
  }
  const h = createHarness();
  Object.defineProperty(h.store, "claimJson", { value: undefined });
  assertThrows(() => h.service.assertPublicationReady());
  const expired = createHarness();
  const result = await expired.service.select([source], "expire");
  assert(result.article);
  expired.service.policy.grants = [{ ...grant, expiresAt: "2000-01-01" }];
  await assertRejects(() => expired.service.reserve(result.article!, "send"));
});
