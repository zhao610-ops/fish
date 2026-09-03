import { startCronJobs } from "@src/controllers/cron.ts";
import {
  initializeAppConfig,
  parseConfigArgs,
  validateAppConfig,
} from "@src/utils/config/app-config.ts";
import { Logger, LogLevel } from "@zilla/logger";
import startServer from "@src/server.ts";
async function bootstrap() {
  const parsedArgs = parseConfigArgs(Deno.args);
  const config = await initializeAppConfig({
    configPath: parsedArgs.configPath,
  });
  await validateAppConfig({ requireLLM: true });

  Logger.level = LogLevel.INFO;

  await startCronJobs();
  await startServer(config.server.port);
}

bootstrap().catch((error) => {
  console.error(error);
  Deno.exit(1);
});
