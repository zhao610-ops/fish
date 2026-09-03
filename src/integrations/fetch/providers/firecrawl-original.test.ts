import { assertEquals, assertRejects } from "@std/assert";
import { FireCrawlScraper } from "./firecrawl-scraper.ts";

Deno.test("候选发现保留原文、未知日期，正确解析相对链接且不强制当天 AI 新闻", async () => {
  const scraper = new FireCrawlScraper("test-key", {
    async scrapeUrl(_url, params) {
      const prompt = (params.extract as { prompt: string }).prompt;
      assertEquals(prompt.includes("不限定 AI/LLM 主题，也不限定当天"), true);
      assertEquals(prompt.includes("保留原文语言，不翻译"), true);
      return {
        success: true,
        extract: {
          stories: [
            {
              headline: "Design research",
              content: "Original excerpt",
              link: "../article",
            },
            { headline: "Invalid", content: "", link: "javascript:alert(1)" },
            { headline: "Missing", content: "", link: "" },
          ],
        },
      };
    },
  });
  const result = await scraper.scrape("https://example.org/blog/news/");
  assertEquals(result.length, 1);
  assertEquals(result[0].url, "https://example.org/blog/article");
  assertEquals(result[0].publishDate, "");
  assertEquals(result[0].content, "Original excerpt");
});

Deno.test("Firecrawl 原文模式只请求 Markdown，不使用翻译提取提示词", async () => {
  const content = "Original English article with all details.";
  const scraper = new FireCrawlScraper("test-key", {
    async scrapeUrl(url, params) {
      assertEquals(params, { formats: ["markdown"], onlyMainContent: true });
      return {
        success: true,
        markdown: content,
        metadata: { title: "Original title", sourceURL: url, statusCode: 200 },
      };
    },
  });
  const result = await scraper.scrape("https://example.org/a", {
    filters: { mode: "original-article" },
  });
  assertEquals(result[0].content, content);
  assertEquals(result[0].title, "Original title");
  assertEquals(result[0].metadata.originalMarkdown, true);
});

Deno.test("Firecrawl 缺原文或缺来源地址时不能用 extract 代替", async () => {
  for (
    const response of [
      {
        success: true,
        extract: { article: { title: "标题", content: "翻译后的摘要" } },
      },
      {
        success: true,
        markdown: "Original text",
        metadata: { title: "Title" },
      },
      {
        success: true,
        markdown: "Login error",
        metadata: {
          title: "Error",
          sourceURL: "https://example.org/a",
          statusCode: 403,
        },
      },
    ]
  ) {
    const scraper = new FireCrawlScraper("test-key", {
      async scrapeUrl() {
        return response;
      },
    });
    await assertRejects(() =>
      scraper.scrape("https://example.org/a", {
        filters: { mode: "original-article" },
      })
    );
  }
});
