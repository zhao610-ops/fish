import { initializeAppConfig } from "@src/utils/config/app-config.ts";

// 读取容器配置并验证受保护的健康接口，不把访问密钥放入命令参数或日志。
try {
  const config = await initializeAppConfig();
  const response = await fetch(
    `http://127.0.0.1:${config.server.port}/api/health`,
    {
      headers: { Authorization: `Bearer ${config.server.apiKey}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok || (await response.json()).ok !== true) Deno.exit(1);
} catch {
  Deno.exit(1);
}
