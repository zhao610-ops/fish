import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import dockerConfig from "../trendpublish.config.docker.example.ts";
import { initializeAppConfig } from "@src/utils/config/app-config.ts";
import { checkDockerHealth } from "./docker-healthcheck.ts";

Deno.test("Docker 健康检查验证鉴权和方案接口，拒绝假健康", async () => {
  for (const status of [200, 500, 401]) {
    const paths: string[] = [];
    const request: typeof fetch = (input, init) => {
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-only-key",
      );
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return Promise.resolve(
        path === "/api/health"
          ? Response.json({ ok: true })
          : Response.json({ profiles: [{ id: "test" }] }, { status }),
      );
    };
    assertEquals(
      await checkDockerHealth(
        "http://localhost:8000",
        "test-only-key",
        request,
      ),
      status === 200,
    );
    assertEquals(paths, [
      "/api/health",
      "/api/config/features/article/profiles",
    ]);
  }
});

Deno.test("Docker 健康检查拒绝空方案、无效响应和网络异常", async () => {
  for (const value of [{ profiles: [] }, { ok: false }, null]) {
    const request: typeof fetch = (input) =>
      Promise.resolve(
        Response.json(
          String(input).endsWith("/api/health") ? { ok: true } : value,
        ),
      );
    assertEquals(
      await checkDockerHealth("http://localhost:8000", "test", request),
      false,
    );
  }
  assertEquals(
    await checkDockerHealth(
      "http://localhost:8000",
      "test",
      () => Promise.reject(new Error("断网")),
    ),
    false,
  );
});

Deno.test("Docker 配置读取运行变量且所有数据库使用持久化目录", async () => {
  const values: Record<string, string> = {
    SERVER_API_KEY: "test-only-server-key",
    AI_API_KEY: "test-only-model-key",
    ARTICLE_SOURCES: "https://example.org/one,https://example.org/two",
  };
  const config = await initializeAppConfig({
    source: dockerConfig,
    runtime: {
      target: "docker",
      value: (name, fallback = "") => values[name] ?? fallback,
      secret: (name, fallback = "") => values[name] ?? fallback,
      required: (name) => {
        if (!values[name]) throw new Error(`缺少 ${name}`);
        return values[name];
      },
    },
  });
  assertEquals(config.server.apiKey, "test-only-server-key");
  assertEquals(config.providers.ai.apiKey, "test-only-model-key");
  assertEquals(config.features.article.sources.length, 2);
  assertEquals(config.features.article.dryRun, true);
  assertEquals(config.features.article.publisher.mode, "draft");
  assertEquals(config.features.article.translation.grants, []);
  for (
    const path of [
      config.storage.artifacts.outputDir,
      config.storage.runState.outputDir,
      config.storage.runtimeConfig.sqlitePath,
      config.storage.vector.sqlitePath,
    ]
  ) assert(path.startsWith("src/temp"));
});

Deno.test("Docker 初始化不需要引擎，支持空格路径且不覆盖已有配置", async () => {
  const root = await Deno.makeTempDir({ prefix: "wx docker init test " });
  try {
    await Deno.mkdir(join(root, "scripts"));
    await Deno.mkdir(join(root, "docker"));
    await Deno.copyFile("scripts/docker.sh", join(root, "scripts/docker.sh"));
    await Deno.copyFile(
      "trendpublish.config.docker.example.ts",
      join(root, "trendpublish.config.docker.example.ts"),
    );
    await Deno.copyFile(
      "docker/runtime.env.example",
      join(root, "docker/runtime.env.example"),
    );
    const command = () =>
      new Deno.Command("sh", {
        args: [join(root, "scripts/docker.sh"), "init"],
        stdout: "piped",
        stderr: "piped",
      }).output();
    const first = await command();
    assertEquals(first.code, 0, new TextDecoder().decode(first.stderr));
    const config = join(root, "config/trendpublish.config.ts");
    const secrets = join(root, "config/runtime.env");
    assertStringIncludes(await Deno.readTextFile(config), "translation");
    await Deno.writeTextFile(secrets, "SERVER_API_KEY=保留用户已填写的配置\n");
    await Deno.writeTextFile(config, "// 保留用户已有配置\n");
    assertEquals((await command()).code, 0);
    assertEquals(
      await Deno.readTextFile(secrets),
      "SERVER_API_KEY=保留用户已填写的配置\n",
    );
    assertEquals(await Deno.readTextFile(config), "// 保留用户已有配置\n");
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(secrets)).mode! & 0o777, 0o600);
    }
  } finally {
    // 只清理测试独立创建的临时目录。
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Docker 默认不暴露公网端口，密钥排除镜像且停止不删除数据卷", async () => {
  const compose = await Deno.readTextFile("docker-compose.yml");
  const ignore = await Deno.readTextFile(".dockerignore");
  const script = await Deno.readTextFile("scripts/docker.sh");
  assertStringIncludes(compose, "127.0.0.1:8000:8000");
  assertStringIncludes(compose, "./config/runtime.env");
  assertStringIncludes(compose, "article-data:/app/src/temp");
  assertStringIncludes(compose, "create_host_path: false");
  assertEquals(/^\s*init:\s*true/m.test(compose), false);
  assertStringIncludes(ignore, "config/");
  assertStringIncludes(script, "--dry-run");
  assertEquals(script.includes("down -v"), false);
  const server = await Deno.readTextFile("src/server.ts");
  assertEquals(
    /logger\.[a-z]+\([^\n]*config\.server\.apiKey/.test(server),
    false,
  );
});
