import { assertEquals, assertRejects } from "@std/assert";
import { ContentScraper } from "@src/core/ports/content-scraper.ts";
import { ArticleSource } from "@src/features/weixin-article/domain/article-source.ts";
import { ArticleFetchRouter } from "./article-fetch-router.ts";

Deno.test("ArticleFetchRouter stops after first provider returns content", async () => {
  const calls: string[] = [];
  const router = new ArticleFetchRouter(
    new Map([
      ["firecrawl", mockScraper("firecrawl", calls, [{ title: "ok" }])],
      ["jina", mockScraper("jina", calls, [{ title: "skip" }])],
    ]),
  );

  const result = await router.scrape(source(["firecrawl", "jina"]));

  assertEquals(result.provider, "firecrawl");
  assertEquals(result.contents.length, 1);
  assertEquals(calls, ["firecrawl"]);
});

Deno.test("ArticleFetchRouter falls back in configured order", async () => {
  const calls: string[] = [];
  const router = new ArticleFetchRouter(
    new Map([
      ["firecrawl", mockScraper("firecrawl", calls, [], new Error("boom"))],
      ["jina", mockScraper("jina", calls, [{ title: "ok" }])],
    ]),
  );

  const result = await router.scrape(source(["firecrawl", "jina"]));

  assertEquals(result.provider, "jina");
  assertEquals(result.contents.length, 1);
  assertEquals(result.failures.length, 1);
  assertEquals(calls, ["firecrawl", "jina"]);
});

Deno.test("ArticleFetchRouter returns all failures when every provider fails", async () => {
  const calls: string[] = [];
  const router = new ArticleFetchRouter(
    new Map([
      ["firecrawl", mockScraper("firecrawl", calls, [], new Error("boom"))],
      ["jina", mockScraper("jina", calls, [])],
    ]),
  );

  const result = await router.scrape(source(["firecrawl", "jina"]));

  assertEquals(result.provider, undefined);
  assertEquals(result.contents.length, 0);
  assertEquals(result.failures.map((failure) => failure.provider), [
    "firecrawl",
    "jina",
  ]);
});

Deno.test("ArticleFetchRouter hydrates article detail with richer content", async () => {
  const calls: string[] = [];
  const router = new ArticleFetchRouter(
    new Map([
      [
        "jina",
        mockScraper("jina", calls, [{
          title: "完整标题",
          content: "完整正文".repeat(140),
        }]),
      ],
    ]),
  );

  const result = await router.hydrate({
    id: "a1",
    title: "短标题",
    content: "短摘要",
    url: "https://example.com/article",
    publishDate: new Date(0).toISOString(),
    metadata: {},
  });

  assertEquals(result.hydrated, true);
  assertEquals(result.provider, "jina");
  assertEquals(result.content.id, "a1");
  assertEquals(result.content.title, "完整标题");
  assertEquals(result.content.metadata.hydrated, true);
  assertEquals(calls, ["jina"]);
});

Deno.test("ArticleFetchRouter keeps original article when hydration is not richer", async () => {
  const calls: string[] = [];
  const router = new ArticleFetchRouter(
    new Map([
      [
        "jina",
        mockScraper("jina", calls, [{
          title: "短内容",
          content: "还是短",
        }]),
      ],
    ]),
  );

  const result = await router.hydrate({
    id: "a1",
    title: "短标题",
    content: "短摘要",
    url: "https://example.com/article",
    publishDate: new Date(0).toISOString(),
    metadata: {},
  });

  assertEquals(result.hydrated, false);
  assertEquals(result.content.title, "短标题");
  assertEquals(result.failures[0].provider, "jina");
  assertEquals(calls, ["jina"]);
});

Deno.test("全文接口接受等长详情，但不能返回摘要或错位地址", async () => {
  const candidate = {
    id: "full",
    title: "标题",
    content: "正文".repeat(200),
    url: "https://example.com/",
    publishDate: "",
    metadata: {},
  };
  const router = new ArticleFetchRouter(
    new Map([["jina", mockScraper("jina", [], [candidate])]]),
  );
  const result = await router.fetchFullArticle(candidate);
  assertEquals(result.metadata.detailFetched, true);
  assertEquals(result.content, candidate.content);
  await assertRejects(() =>
    router.fetchFullArticle({ ...candidate, url: "https://example.com/other" })
  );
  const failed = new ArticleFetchRouter(
    new Map([["jina", mockScraper("jina", [], [], new Error("抓取失败"))]]),
  );
  await assertRejects(() => failed.fetchFullArticle(candidate));
  const short = new ArticleFetchRouter(
    new Map([[
      "jina",
      mockScraper("jina", [], [{ title: "摘要", content: "太短" }]),
    ]]),
  );
  await assertRejects(() => short.fetchFullArticle(candidate));
});

function source(providers: ArticleSource["providers"]): ArticleSource {
  return {
    raw: "web:https://example.com/",
    group: "web",
    url: "https://example.com/",
    kind: "url",
    providers,
  };
}

function mockScraper(
  name: string,
  calls: string[],
  contents: Array<Record<string, unknown>>,
  error?: Error,
): ContentScraper {
  return {
    async scrape() {
      calls.push(name);
      if (error) {
        throw error;
      }
      return contents.map((item, index) => ({
        id: `${name}_${index}`,
        title: String(item.title),
        content: String(item.content ?? item.title),
        url: "https://example.com/",
        publishDate: new Date(0).toISOString(),
        metadata: {},
      }));
    },
  };
}
