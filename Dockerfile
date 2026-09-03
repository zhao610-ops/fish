FROM denoland/deno:2.7.14

WORKDIR /app

ENV DENO_DIR=/deno-dir
ENV TRENDPUBLISH_RUNTIME=docker
ENV TRENDPUBLISH_CONFIG=/app/config/trendpublish.config.ts

COPY deno.json deno.lock ./
COPY dashboard ./dashboard
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY trendpublish.config.example.ts ./trendpublish.config.example.ts
COPY trendpublish.config.docker.example.ts ./trendpublish.config.docker.example.ts
COPY trendpublish.config.cloudflare.ts ./trendpublish.config.cloudflare.ts
COPY wrangler.jsonc ./wrangler.jsonc

RUN deno run --config dashboard/deno.json -A npm:vite@8.0.13 build --config dashboard/vite.config.ts
RUN deno cache src/index.ts src/apps/weixin-relay/server.ts scripts/task-runner.ts scripts/run.workflow.ts scripts/doctor.ts scripts/preview.weixin.ts scripts/docker-healthcheck.ts
# 构建时加载当前容器架构的 SQLite 动态库，避免首次启动时再下载。
RUN deno run -A scripts/docker-warmup.ts
RUN mkdir -p /app/config /app/src/temp \
  && ln -s /app/src /app/config/src \
  && chown -R deno:deno /app /deno-dir

USER deno

EXPOSE 8000

CMD ["deno", "run", "-A", "src/index.ts"]
