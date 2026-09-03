# 部署

TrendPublish 只有一套配置模型：`trendpublish.config.ts`。本地、Docker、
Cloudflare 和 weixin-relay 都读这份 TypeScript
配置结构；密钥可以写在配置文件里， 也可以通过
`defineConfig((runtime) => config)` 从 Docker secrets、Cloudflare secrets
或运行环境显式读取。

## 先选部署形态

优先按下面三种形态选择，不需要一开始就全部部署：

1. **本地开发** 用于改代码、调 Dashboard、跑 dry-run。
2. **Docker 服务器** 推荐给大多数自部署用户。功能完整，SQLite
   和文件产物都在挂载目录里。
3. **Cloudflare Workflows** 推荐给想要 Serverless 定时运行的人。使用 Worker +
   Workflows + D1/KV/R2。

微信真实发布还要考虑微信 IP 白名单：

- 服务器/Docker 有固定公网 IP：可以直连微信，使用
  `publisher.provider: "weixin"`。
- Cloudflare 没有固定出口 IP：建议部署 `weixin-relay` 到固定 IP 机器，Cloudflare
  调用 relay，并把本次选择的公众号凭证随请求透传给 relay。

## 本地开发

```bash
cp trendpublish.config.example.ts trendpublish.config.ts
deno task doctor
deno task dev
```

访问：

```text
API:       http://localhost:8000
Dashboard: http://localhost:5173/dashboard/
```

常用命令：

```bash
deno task preview             # 预览微信模板
deno task article --dry-run   # 跑一次 dry-run
deno task verify              # 发布前完整验证
```

## Docker 部署

使用当前代码本地构建镜像，完整步骤见
[Docker 运行指南](docker.md)。无需在宿主机安装 Deno。

```bash
sh scripts/docker.sh init
# 填写 config 目录中的模型、抓取、来源及授权配置
sh scripts/docker.sh up
sh scripts/docker.sh doctor
sh scripts/docker.sh preview
```

默认后台为
`http://localhost:8000/dashboard/`，只监听本机。后台密钥自行设置，默认只预览，不会公开发表。

容器以非 root
用户运行，配置只读挂载，SQLite、文章和发送占位保存在命名数据卷中。重新创建容器保留数据；旧宿主机数据不会自动迁移，升级前先备份。

```bash
sh scripts/docker.sh logs
sh scripts/docker.sh restart
sh scripts/docker.sh stop
```

真实发表前仍需核实公众号接口权限、配置出口 IP 白名单、自有封面、转载授权与平台
AI 标识，参见 [全文翻译与发布配置](translation-publishing.md)。

## Cloudflare 部署

Cloudflare 形态使用：

- Worker：HTTP API、Dashboard、Cron heartbeat。
- Workflows：执行微信文章步骤。
- D1：运行历史、步骤、运行时配置、向量去重。
- KV：最近运行状态和轻量 artifact fallback。
- R2：推荐保存 HTML、JSON、图片等大产物。

入口文件和配置：

```text
src/platform/cloudflare/worker.ts
wrangler.jsonc
trendpublish.config.cloudflare.ts
```

登录：

```bash
deno run -A npm:wrangler login
deno run -A npm:wrangler whoami
```

### Cloudflare 资源

如果仓库里的 `wrangler.jsonc` 已经填好
KV/D1/R2，可以跳过创建资源。需要手工创建时：

```bash
deno run -A npm:wrangler kv namespace create ARTICLE_RUNS
deno run -A npm:wrangler d1 create trendpublish
deno run -A npm:wrangler r2 bucket create trendpublish-artifacts
```

把返回值写入 `wrangler.jsonc`：

```jsonc
{
  "kv_namespaces": [{ "binding": "ARTICLE_RUNS", "id": "真实 KV id" }],
  "d1_databases": [{
    "binding": "ARTICLE_DB",
    "database_name": "trendpublish",
    "database_id": "真实 D1 id",
    "migrations_dir": "migrations"
  }],
  "r2_buckets": [
    { "binding": "ARTICLE_ARTIFACTS", "bucket_name": "trendpublish-artifacts" }
  ]
}
```

R2 暂时没开也能先用 KV artifact fallback 跑通 dry-run；生产建议开启 R2。

### Cloudflare secrets

最小 dry-run 通常需要：

```bash
deno run -A npm:wrangler secret put SERVER_API_KEY
deno run -A npm:wrangler secret put AI_API_KEY
```

按数据源和功能再补：

```bash
deno run -A npm:wrangler secret put FIRECRAWL_API_KEY
deno run -A npm:wrangler secret put JINA_API_KEY
deno run -A npm:wrangler secret put DASHSCOPE_API_KEY
```

Cloudflare 真实发布推荐走 relay：

```bash
deno run -A npm:wrangler secret put WEIXIN_PUBLISH_PROVIDER # 填 weixin-relay
deno run -A npm:wrangler secret put WEIXIN_APP_ID
deno run -A npm:wrangler secret put WEIXIN_APP_SECRET
deno run -A npm:wrangler secret put WEIXIN_RELAY_URL
deno run -A npm:wrangler secret put WEIXIN_RELAY_TOKEN
deno run -A npm:wrangler secret put WEIXIN_ACCOUNT_ID       # 多公众号时填 main/lab
```

也可以从本地配置同步 secrets。脚本只打印变量名，不输出变量值：

```bash
deno task cf sync-secrets --env-file cloudflare-token.local
```

### Cloudflare 验证和部署

本地检查 Worker 打包：

```bash
deno task cf dry-run
```

本地 Wrangler dev：

```bash
deno task cf migrate:local
deno task cf dev
```

打开：

```text
http://localhost:8787/dashboard
```

远端部署：

```bash
deno task cf migrate
deno task cf deploy
```

部署后冒烟：

```bash
deno task cf smoke --url https://<your-worker>.<your-subdomain>.workers.dev \
  --api-key <SERVER_API_KEY>
```

常用 API：

```text
GET  /api/health
GET  /api/config/summary
POST /api/runs
POST /api/runs/matrix
GET  /api/runs
GET  /api/runs/:runId
GET  /api/artifacts?key=...
GET  /dashboard
```

`POST /api/workflow` 仍保留为旧 JSON-RPC 兼容入口。

## 微信发布 relay

Cloudflare 没有固定出口 IP，微信公众号发布又常要求 IP 白名单，所以建议把
`weixin-relay` 放在一台固定 IP 机器：

```text
Cloudflare Worker/Workflow -> weixin-relay(固定 IP) -> 微信公众号 API
```

relay 只做两件事：

- 代理微信上传图片、创建草稿等 API。
- 校验自己的 Bearer Token，拒绝未授权调用。

relay 不保存公众号
AppID/AppSecret，不暴露账号列表，也不参与选题和内容生成。账号凭证、
账号定位、受众、语气、默认文章方案都保存在主服务侧；主服务每次调用 relay 时只
透传本次发布所需的账号凭证。

### Docker 运行 relay

relay 和主服务使用同一个镜像，只是启动命令不同：

```bash
mkdir -p config
cp trendpublish.config.docker.example.ts config/trendpublish.config.ts
```

relay 机器配置只需要：

- `server.apiKey`：主服务调用 relay 的 Bearer Token。

启动：

```bash
deno task docker relay
deno task docker relay logs
```

健康检查：

```bash
curl http://<relay-host>:8080/health
```

### 源码运行 relay

不想用 Docker 时可以源码运行：

```bash
git clone https://github.com/liyown/ai-trend-publish.git
cd ai-trend-publish
mkdir -p config
cp trendpublish.config.example.ts config/trendpublish.config.ts
```

如果配置放在 `config/` 目录，第一行建议使用：

```ts
import { defineConfig } from "@src/utils/config/define-config.ts";
```

前台验证：

```bash
PORT=8080 deno task relay --config ./config/trendpublish.config.ts
```

生产建议一键安装 systemd：

```bash
deno task relay install \
  --config ./config/trendpublish.config.ts \
  --port 8080
```

查看日志：

```bash
sudo journalctl -u trendpublish-weixin-relay -f
```

需要自定义目录或用户：

```bash
deno task relay install \
  --workdir /opt/ai-trend-publish \
  --config /opt/ai-trend-publish/config/trendpublish.config.ts \
  --user trendpublish \
  --port 8080
```

## Dashboard 和运行时配置

Dashboard 地址：

```text
本地/Docker: http://<host>:8000/dashboard
Cloudflare:  https://<worker-domain>/dashboard
```

首次打开输入 `server.apiKey`。Dashboard 修改的是 SQLite/D1 里的运行时业务配置：

- 数据源
- 抓取分组
- 文章方案
- 账号矩阵
- 共享能力 Profile
- 定时规则

下一次手动运行或定时触发会立即使用新配置。已经运行中的 workflow
使用启动时快照，不受中途修改影响。

密钥、Cloudflare binding、Docker volume、relay 地址这类部署级配置仍需要改
`trendpublish.config.ts` 或平台 secrets。

## 日志观测

本地、Docker、Cloudflare 和 relay 都使用统一 `Logger`。开启 `observability`
后，所有 `info/warn/error/debug` 日志会额外镜像到配置的 sink，并带上
`runId`、`step`、`profileId` 等上下文。

常见 sink：

- Axiom：`observability.axiom.dataset/token`
- Better Stack Logs：`observability.betterStack.sourceToken`
- 其他平台：`observability.http.endpoint`

Cloudflare 控制台仍能看到普通 Workers
日志；外部日志平台更适合长期保存、检索和告警。

## 发布前检查

推荐顺序：

```bash
deno task verify
deno task doctor --config ./config/trendpublish.config.ts
deno task article --dry-run --config ./config/trendpublish.config.ts
```

正式发布前确认：

1. `features.article.dryRun` 已按预期设置。
2. 微信公众号后台已经配置服务器或 relay 机器的 IP 白名单。
3. 开启的抓取、图片、通知、去重 provider 都已配置凭证。
4. Docker 宿主机已挂载 `./data/temp`，方便查看 dry-run 输出。
5. Cloudflare 已执行 `deno task cf migrate` 并通过 `deno task cf smoke`。
