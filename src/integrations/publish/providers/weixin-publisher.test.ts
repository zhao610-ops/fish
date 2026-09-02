import { assertEquals, assertRejects } from "@std/assert";
import { resolveTrendPublishConfig } from "@src/utils/config/define-config.ts";
import { WeixinApiClient } from "./weixin-api-client.ts";
import { WeixinPublisher } from "./weixin-publisher.ts";
import type { PublishResult } from "@src/core/ports/content-publisher.ts";

const article = {
  title: "测试文章",
  digest: "摘要",
  content: "<p>正文</p>",
  coverMediaId: "cover",
};
function fixture(responses: Record<string, unknown>) {
  const calls: { path: string; body: unknown }[] = [];
  const config = resolveTrendPublishConfig({
    providers: {
      publish: { weixin: { appId: "wx-test", appSecret: "test-secret" } },
    },
  });
  const client = new WeixinApiClient({
    fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (path === "/cgi-bin/token") {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      if (!(path in responses)) {
        throw new Error(`不允许的请求: ${path}`);
      }
      return Response.json(responses[path]);
    }) as typeof fetch,
  });
  return {
    calls,
    publisher: new WeixinPublisher(
      config.providers.publish.weixin,
      undefined,
      client,
    ),
  };
}

Deno.test("自动发表按顺序创建草稿并提交，不调用群发接口，也不提前标记成功", async () => {
  const { publisher, calls } = fixture({
    "/cgi-bin/draft/add": { media_id: "draft-id" },
    "/cgi-bin/freepublish/submit": { publish_id: "publish-id" },
  });
  const result = await publisher.publishArticle({
    ...article,
    mode: "publish",
    requestId: "run-1",
  });
  assertEquals(result.status, "pending");
  assertEquals(result.publishId, "publish-id");
  assertEquals(result.draftMediaId, "draft-id");
  assertEquals(result.url, undefined);
  assertEquals(calls.map((call) => call.path), [
    "/cgi-bin/token",
    "/cgi-bin/draft/add",
    "/cgi-bin/freepublish/submit",
  ]);
  assertEquals(calls[2].body, { media_id: "draft-id" });
});

Deno.test("草稿模式不触发发表且不拼接虚假的文章地址", async () => {
  const { publisher, calls } = fixture({
    "/cgi-bin/draft/add": { media_id: "draft-id" },
  });
  const result = await publisher.publishArticle(article);
  assertEquals(result.status, "draft");
  assertEquals(result.url, undefined);
  assertEquals(calls.length, 2);
});

const pending: PublishResult = {
  publishId: "publish-id",
  status: "pending",
  mode: "publish",
  platform: "weixin",
  publishedAt: new Date(),
  accountId: "default",
};
for (const status of [0, 1, 2, 3, 4, 5, 6]) {
  Deno.test(`微信发表状态 ${status} 正确映射且只查询不重发`, async () => {
    const { publisher, calls } = fixture({
      "/cgi-bin/freepublish/get": {
        publish_status: status,
        article_id: "article-id",
        article_detail: {
          item: [{ article_url: "https://mp.weixin.qq.com/s/real-article" }],
        },
      },
    });
    const result = await publisher.getPublishStatus(pending);
    assertEquals(
      result.status,
      status === 0 ? "published" : status === 1 ? "pending" : "failed",
    );
    assertEquals(calls.map((call) => call.path), [
      "/cgi-bin/token",
      "/cgi-bin/freepublish/get",
    ]);
    if (status === 0) {
      assertEquals(result.url, "https://mp.weixin.qq.com/s/real-article");
    }
  });
}

Deno.test("缺少发表链接或遇到未知状态时不误报成功", async () => {
  for (const response of [{ publish_status: 0 }, { publish_status: 99 }]) {
    const { publisher } = fixture({ "/cgi-bin/freepublish/get": response });
    await assertRejects(() => publisher.getPublishStatus(pending));
  }
});

Deno.test("发表接口权限错误保留错误信息，不降级为草稿成功", async () => {
  const { publisher } = fixture({
    "/cgi-bin/draft/add": { media_id: "draft-id" },
    "/cgi-bin/freepublish/submit": {
      errcode: 48001,
      errmsg: "api unauthorized",
    },
  });
  await assertRejects(
    () => publisher.publishArticle({ ...article, mode: "publish" }),
    Error,
    "48001",
  );
});
