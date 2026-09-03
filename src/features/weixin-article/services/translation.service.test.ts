import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { ChatMessage, LLMProvider } from "@src/core/ports/llm.ts";
import type { ScrapedContent } from "@src/core/ports/content-scraper.ts";
import { MemoryArtifactStore } from "@src/core/storage/memory-artifact-store.ts";
import { cleanArticleBody } from "./article-source-cleaner.ts";
import {
  balanceArticleCandidates,
  nonArticleReason,
} from "./translation-candidates.ts";

Deno.test("库存排除链接按正文地址去重，不受跟踪参数和片段变化影响", async () => {
  const h = createHarness();
  const candidate = {
    ...source,
    url: "https://example.org/tutorials/one?utm_source=rss&#038;utm_medium=rss",
  };
  const result = await h.service.select(
    [candidate],
    "exclude-ready",
    new Set(["https://example.org/tutorials/one?utm_source=other"]),
  );
  assertEquals(result.article, undefined);
  assertEquals(h.fetches(), 0);
});

Deno.test("MeasuringU 去除 Cookie、署名和购物车，保留正文与结论", () => {
  const title = "Nine Design Fixes";
  const raw =
    `Cookie notice\n\n# ${title}\n\n# ${title}\n\n${title}\n\nAuthor name\n\nSeptember 1, 2026\n\n${source.content}\n\n#### Stay informed with MeasuringU.\n\nGet the latest research insights delivered weekly to your inbox.\n\nEmail\n\nSubscribe\n\n## Summary and Discussion\n\n正文结尾仍需接受安全审核\n\n0\n\n0\n\nYour Cart\n\nYour cart is empty [Return to Shop](https://measuringu.com/shop/)\n\nScroll to Top`;
  const cleaned = cleanArticleBody(
    raw,
    title,
    "https://measuringu.com/article/",
  );
  assertStringIncludes(cleaned, source.content.trim());
  assert(cleaned.endsWith("正文结尾仍需接受安全审核"));
  for (
    const noise of [
      "Cookie",
      "Author name",
      "Subscribe",
      "Your Cart",
      "Scroll to Top",
    ]
  ) {
    assertEquals(cleaned.includes(noise), false);
  }
  assertEquals(cleanArticleTitle(`${title} – MeasuringU`), title);
  assertThrows(() =>
    cleanArticleBody(
      raw.replace("Your Cart", "Unknown"),
      title,
      "https://measuringu.com/article/",
    )
  );
});

Deno.test("模型 JSON 格式错误只重试一次，重复错误不放行", async () => {
  for (const alwaysInvalid of [false, true]) {
    let attempts = 0;
    const h = createHarness({
      reply: (stage) => {
        if (stage !== "原文安全与完整性检查") return;
        attempts++;
        if (attempts === 1 || alwaysInvalid) {
          return '{"decision":"allow"} extra';
        }
      },
    });
    const result = await h.service.select([source], `json-${alwaysInvalid}`);
    assertEquals(attempts, 2);
    assertEquals(Boolean(result.article), !alwaysInvalid);
    if (alwaysInvalid) {
      assertStringIncludes(result.rejected[0].reason, "连续两次返回无效 JSON");
    }
  }
});

Deno.test("审核的有效拒绝结论不重试为放行结论", async () => {
  const h = createHarness({
    reply: (stage) =>
      stage === "原文安全与完整性检查"
        ? {
          decision: "block",
          reason: "包含政治内容",
          complete: true,
          language: "en",
          withinAllowedTopics: false,
          qualityScore: 90,
        }
        : undefined,
  });
  const result = await h.service.select([source], "valid-block");
  assertEquals(result.article, undefined);
  assertEquals(h.calls.length, 1);
});

Deno.test("跨来源轮询候选，课程目录不占用全文抓取预算", async () => {
  const a = { ...source, url: "https://a.example.org/first" };
  const b = { ...source, url: "https://b.example.org/first" };
  const a2 = { ...source, url: "https://a.example.org/second" };
  assertEquals(balanceArticleCandidates([a, a2, b]).map((x) => x.url), [
    a.url,
    b.url,
    a2.url,
  ]);
  const course = {
    ...source,
    url: "https://www.nngroup.com/training/november/",
  };
  assert(nonArticleReason(course));
  assertEquals(
    nonArticleReason({ ...source, title: "How to design an online course" }),
    undefined,
  );
  const h = createHarness({ policy: { maxCandidates: 2 } });
  const result = await h.service.select([course, a, a2, b], "balanced");
  assertEquals(h.fetches(), 2);
  assertEquals(
    h.calls.filter((c) => c.stage === "原文安全与完整性检查").map((c) =>
      c.data.url
    ),
    [a.url, b.url],
  );
  assertEquals(result.rejected[0].stage, "候选预筛");
});

Deno.test("日期语义等价允许翻译，改动日期、正文数值、URL 或代码仍拒绝", () => {
  for (
    const [original, translated] of [
      ["August 28, 2026", "2026年8月28日"],
      ["28 Aug 2026", "2026年08月28日"],
      ["2026-08-28", "2026年8月28日"],
      ["November 2026", "2026年11月"],
      ["Rate: 20%", "比例：20％"],
      [
        "[Guide](https://example.org/a?campaign=2026%20) has 3 tips",
        "[指南](https://example.org/a?campaign=2026%20) 有 3 个技巧",
      ],
    ]
  ) assertPreservedLiterals(original, translated);
  for (
    const [original, translated] of [
      ["August 28, 2026", "2026年9月28日"],
      ["2026-08-28", "2026年8月29日"],
      ["GPT-4.1 costs 20", "GPT-4.2 价格 20"],
      ["[Guide](https://example.org/2026)", "[指南](https://example.org/2027)"],
      ["`August 28, 2026`", "`2026年8月28日`"],
    ]
  ) assertThrows(() => assertPreservedLiterals(original, translated));
});

Deno.test("NN/g 在长度检查和审核前去除网页模板，但保留正文尾部风险内容", async () => {
  const url = "https://www.nngroup.com/articles/example/";
  const body = source.content + "\n\n## Conclusion\n\n政治内容仍必须检查";
  const raw = "Cookie notice\n\n".repeat(3000) +
    "# Developer workflow\n\nAuthor name\n\nAugust 28, 2026\n\nSummary:\n" +
    body +
    "\n\n## Related Courses\n\n[Course](https://www.nngroup.com/courses/example/)";
  const h = createHarness({
    fetch: async () => ({
      ...source,
      title: "Developer workflow - NN/G",
      url,
      content: raw,
    }),
    reply: (stage) =>
      stage === "原文安全与完整性检查"
        ? {
          decision: "block",
          reason: "正文尾部包含排除主题",
          complete: true,
          language: "en",
          withinAllowedTopics: true,
          qualityScore: 90,
        }
        : undefined,
  });
  const result = await h.service.select([{ ...source, url }], "nng-clean");
  assertEquals(result.article, undefined);
  assertStringIncludes(h.calls[0].data.content, "政治内容仍必须检查");
  assertEquals(h.calls[0].data.content.includes("Cookie notice"), false);
  assertEquals(h.calls[0].data.content.includes("Author name"), false);
  assertEquals(h.calls[0].data.content.includes("Related Courses"), false);
  const original = result.artifacts.find((ref) =>
    /\/source-[a-f0-9]+\.json$/.test(ref.key)
  );
  assert(original);
  assertStringIncludes(await h.store.getText(original), "Cookie notice");
  assertThrows(() =>
    cleanArticleBody(
      raw.replace("## Related Courses", "## Unknown"),
      "Developer workflow",
      url,
    )
  );
});

Deno.test("翻译校验失败最多纠正一次并保存两次输出，不放宽核验", async () => {
  let titleAttempts = 0;
  const h = createHarness({
    fetch: async () => ({ ...source, title: "2026 Developer workflow" }),
    reply: (stage, data) => {
      if (stage === "忠实翻译" && data.source.startsWith("2026")) {
        titleAttempts++;
        return {
          text: titleAttempts === 1 ? "开发者工作流" : "2026 开发者工作流",
        };
      }
    },
  });
  const result = await h.service.select([source], "correct-number");
  assert(result.article);
  assertEquals(titleAttempts, 2);
  assertEquals(
    result.artifacts.filter((ref) =>
      /translation-title-.*-attempt-/.test(ref.key)
    ).length,
    2,
  );
});

Deno.test("翻译正文使用文本响应，不让长 Markdown 承受 JSON 转义限制", async () => {
  const h = createHarness();
  const result = await h.service.select([source], "plain-translation");
  assert(result.article);
  const translation = h.calls.find((call) => call.stage === "忠实翻译")!;
  assertStringIncludes(translation.messages[0].content, "不要 JSON");
  assertEquals(result.article.markdown.startsWith('{"text"'), false);
});
import {
  REQUIRED_BLOCKED_TOPICS,
  resolveTranslationPolicy,
  safeSourceUrl,
  type TranslationPolicy,
} from "../domain/translation-policy.ts";
import {
  ArticleTranslationService,
  assertPreservedLiterals,
  cleanArticleTitle,
  renderTranslation,
  splitTranslationChunks,
} from "./translation.service.ts";

const source: ScrapedContent = {
  id: "article",
  title: "Developer workflow",
  content:
    "A useful workflow improves developer productivity and keeps the code readable.\n\n"
      .repeat(5),
  url: "https://example.org/tutorials/one",
  publishDate: "2026-09-01",
  metadata: { detailFetched: true, author: "测试作者" },
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
            content: typeof value === "string"
              ? value
              : stage === "忠实翻译"
              ? (value as { text: string }).text
              : JSON.stringify(value),
          },
        }],
      };
    },
  };
  const store = options.store ?? new MemoryArtifactStore();
  const policy = resolveTranslationPolicy({
    coverMediaId: "own-cover",
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

Deno.test("移除人工门禁后仍保留固定主题限制和安全来源地址检查", () => {
  const policy = resolveTranslationPolicy({
    blockedTopics: [],
  });
  assertEquals(policy.blockedTopics, REQUIRED_BLOCKED_TOPICS);
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
});

Deno.test("不配置授权表或人工确认即可完成翻译并进行发送占位", async () => {
  const h = createHarness();
  const result = await h.service.select([source], "automatic");
  assert(result.article);
  assertEquals(h.fetches(), 1);
  assertEquals(result.article.html.includes("测试作者"), false);
  assertStringIncludes(result.article.html, "AI 辅助翻译");
  assertEquals(result.article.html.includes("授权依据"), false);
  assertEquals(result.article.html.includes("许可："), false);
  await h.service.reserve(result.article, "automatic");
  assert(await h.store.getObject(result.article.urlKey));
});

Deno.test("危险地址仍在抓取前拒绝，不调用模型", async () => {
  const h = createHarness();
  const result = await h.service.select([{
    ...source,
    url: "https://127.0.0.1/private",
  }], "unsafe-url");
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
    assertEquals(h.calls.length, options.finishReason === "length" ? 1 : 2);
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
    "![Figure 2](https://images.example.org/2026/photo700.png)",
    "图 2",
  );
  assertThrows(() =>
    assertPreservedLiterals(
      "![Figure 2](https://images.example.org/2026/photo700.png)",
      "图 3",
    )
  );
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

Deno.test("Medium 模板清理去掉署名卡片而保留副标题、引用、真实数字和结尾", () => {
  const body = "Alice explained the 2026 findings.\n\n".repeat(12) +
    "Complete ending.";
  const raw = [
    "Navigation",
    "# **Developer workflow**",
    "## Subtitle",
    "[Alice](https://medium.com/@alice?source=post_page---byline--id)",
    "10 min read",
    "[Listen](https://medium.com/?source=---header_actions--id)",
    "Share",
    body,
    "[UX](https://medium.com/tag/ux?source=post_page---footer_tags--id)",
    "Written by Alice",
    "119 followers",
  ].join("\n\n");
  assertEquals(
    cleanArticleBody(raw, "Developer workflow"),
    "## Subtitle\n\n" + body,
  );
  assertEquals(cleanArticleBody(body, "Developer workflow"), body);
  assertThrows(() =>
    cleanArticleBody(raw.replace("Share", "Unknown"), "Developer workflow")
  );
});

Deno.test("成稿去除图片和不可信链接，保留来源但不额外附加署名和原文标题", () => {
  const html = renderTranslation(
    "译文",
    '<script>alert("x")</script>\n\n![图](https://evil.org/image.png)\n\n[坏链接](javascript:alert)\n\n<img src=x onerror=alert(1)>',
    source.url,
  );
  assertEquals(/<script|<img|href="javascript:/i.test(html), false);
  assertEquals(html.includes("原作者："), false);
  assertEquals(html.includes("原文标题："), false);
  assertStringIncludes(html, source.url);
  assertStringIncludes(html, "Microsoft YaHei");
  const linked = renderTranslation(
    "标题",
    "[指南](https://example.org/guide) 和 `<script>`",
    source.url,
  );
  assertStringIncludes(linked, 'href="https://example.org/guide"');
  assertEquals(linked.includes("<script>"), false);
  assertStringIncludes(linked, "&lt;script&gt;");
  assertStringIncludes(html, "AI 辅助翻译");
});

Deno.test("清理明确署名后缀，不删除标题内的数字和正常分隔符", () => {
  assertEquals(
    cleanArticleTitle(
      "When the canvas starts acting, who’s really in control? | by Aurélie Radom | Sep, 2026 | UX Collective",
    ),
    "When the canvas starts acting, who’s really in control?",
  );
  assertEquals(
    cleanArticleTitle("2026 design | by Alice | Sep, 2026 | Blog"),
    "2026 design",
  );
  assertEquals(
    cleanArticleTitle("GPT-4.1 | A new workflow in 2026"),
    "GPT-4.1 | A new workflow in 2026",
  );
});

Deno.test("附带署名年份的网页标题清理后可以通过翻译，原始产物仍保留", async () => {
  const h = createHarness({
    fetch: async () => ({
      ...source,
      title: "Developer workflow | by Alice | Sep, 2026 | Blog",
    }),
  });
  const result = await h.service.select([source], "metadata-title");
  assert(result.article);
  assertEquals(
    h.calls.find((call) => call.stage === "忠实翻译")?.data.source,
    "Developer workflow",
  );
  const ref = result.artifacts.find((ref) =>
    /\/source-[a-f0-9]+\.json$/.test(ref.key)
  );
  assert(ref);
  assertStringIncludes(await h.store.getText(ref), "Sep, 2026");
});

Deno.test("真实标题数字错译仍拒绝，并保存失败译文与数字差异", async () => {
  const h = createHarness({
    fetch: async () => ({ ...source, title: "2026 Developer workflow" }),
  });
  const result = await h.service.select([source], "bad-title-number");
  assertEquals(result.article, undefined);
  assertStringIncludes(result.rejected[0].reason, "标题：");
  assertStringIncludes(result.rejected[0].reason, "2026");
  const ref = result.artifacts.find((ref) =>
    ref.key.includes("translation-title-")
  );
  assert(ref);
  const diagnostic = await h.store.getJson<
    { source: string; text: string; status: string }
  >(ref);
  assertEquals(diagnostic.status, "rejected");
  assertEquals(diagnostic.source, "2026 Developer workflow");
  assertEquals(diagnostic.text, "开发者工作流");
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

Deno.test("未配置封面或原子存储仍不能真实发送", () => {
  assertThrows(() =>
    createHarness({ policy: { coverMediaId: "" } }).service
      .assertPublicationReady()
  );
  const h = createHarness();
  Object.defineProperty(h.store, "claimJson", { value: undefined });
  assertThrows(() => h.service.assertPublicationReady());
});
