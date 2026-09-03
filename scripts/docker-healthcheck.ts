import { initializeAppConfig } from "@src/utils/config/app-config.ts";

// 同时验证存活接口和方案读取，避免后台配置报错却被标记为健康。
export async function checkDockerHealth(
  baseUrl: string,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const options = {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    };
    const health = await request(`${baseUrl}/api/health`, options);
    if (!health.ok) {
      await health.body?.cancel();
      return false;
    }
    if ((await health.json()).ok !== true) return false;
    const profiles = await request(
      `${baseUrl}/api/config/features/article/profiles`,
      options,
    );
    if (!profiles.ok) {
      await profiles.body?.cancel();
      return false;
    }
    const data = await profiles.json();
    return Array.isArray(data.profiles) && data.profiles.length > 0;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  // 不把访问密钥放入命令参数或日志。
  try {
    const config = await initializeAppConfig();
    Deno.exit(
      await checkDockerHealth(
          `http://127.0.0.1:${config.server.port}`,
          config.server.apiKey,
        )
        ? 0
        : 1,
    );
  } catch {
    Deno.exit(1);
  }
}
