# Docker 运行指南

本方式把后台、定时任务、Deno、前端资源和 SQLite
放在同一个容器里，不需要在电脑安装 Deno、Node.js
或独立数据库。镜像从当前项目构建，不使用其他项目的远程成品镜像。

## 1. 初始化

Mac 上启动 Docker Desktop，等引擎就绪。在项目目录执行：

```bash
sh scripts/docker.sh init
```

这会创建两个文件，重复执行不会覆盖已有内容：

- `config/runtime.env`：后台访问密钥、模型与抓取服务密钥、公众号凭证。仅供本地使用，已排除版本控制与镜像构建上下文；初始化时限制为当前用户读写。
- `config/trendpublish.config.ts`：主题限制、授权来源、功能和存储配置，只读挂载进容器。不要往这个可读配置文件写密钥，使用运行变量或现有
  secrets 接口。

## 2. 填写配置

编辑 `config/runtime.env`：

```dotenv
SERVER_API_KEY=自己设置一段足够长的随机后台访问密钥
AI_BASE_URL=你的模型服务接口地址
AI_MODEL=模型名称
AI_API_KEY=模型服务密钥
JINA_API_KEY=全文抓取服务密钥
```

可以用 `FIRECRAWL_API_KEY` 替代
Jina。预览不需要公众号凭证，但模型和抓取调用可能收费。 不要把配置文件、完整
`docker compose config` 输出或 `docker inspect`
输出分享给别人，它们可能包含密钥。

来源可以写在 `ARTICLE_SOURCES` 中，用逗号分隔；URL 本身含逗号时改用 TypeScript
的 `sources` 数组。无需另填项目授权表或 AI
标识人工确认开关，示例域名不是实际文章来源。详见
[全文翻译与发布配置](translation-publishing.md)。

例如 `ARTICLE_SOURCES=https://example.org/articles,https://example.net/feed`，
等号右侧不要再粘贴一次 `ARTICLE_SOURCES=`；示例地址须换成你已获授权的真实来源。

## 3. 构建并启动

```bash
sh scripts/docker.sh up
```

第一次需要下载基础镜像和依赖、构建后台页面，通常比后续启动慢。需要能访问镜像仓库、npm、JSR
和 SQLite 二进制下载地址；网络不通时先修复网络，不跳过 TLS 校验。

启动脚本等待健康检查通过后显示地址：

```text
http://localhost:8000/dashboard/
```

后台访问密钥为 `SERVER_API_KEY`。默认端口仅绑定
`127.0.0.1`，局域网其他电脑不能直接访问；远程部署请通过 SSH 隧道或配置带 HTTPS
和访问控制的反向代理。

健康检查验证服务与配置可以响应，不代表模型、抓取服务或公众号已通过真实业务验证。

## 4. 体检和预览

```bash
sh scripts/docker.sh doctor
sh scripts/docker.sh preview
```

这两条命令启动临时容器，与主容器共享数据卷。`preview` 始终传入
`--dry-run`，不会发表文章。不要通过这个入口绕过审核；正式发表请在后台配置方案和定时规则。

`doctor` 报缺少抓取服务等问题时，应先补齐对应配置。封面、AI
标识和公众号权限按真实发表要求另行核实。

## 常用操作

```bash
sh scripts/docker.sh status    # 容器状态
sh scripts/docker.sh logs      # 最近日志并持续跟踪，Ctrl+C 仅退出日志
sh scripts/docker.sh restart   # 重新创建容器，载入更新后的运行变量和配置
sh scripts/docker.sh stop      # 停止容器，保留数据卷
sh scripts/docker.sh up        # 更新代码后重新构建并启动
```

配置更新不要只用 `docker compose restart`：它不会重新加载运行变量，建议用上述
`restart` 命令。

默认 Compose 项目名为 `wx-translator`，服务名为 `trendpublish`，数据卷为
`wx-translator_article-data`。数据位于容器
`/app/src/temp`，包括文章、运行记录、后台配置数据库及 `translation-claims/`
发送占位。容器采用非 root
用户；数据卷初始权限由镜像准备，不需要把宿主机目录开放为全员可写。

`stop` 不删数据；不要执行带 `-v` 的删除命令或手动删除这个数据卷。Docker Desktop
自身重置或清除磁盘仍可能丢失数据，必须另外备份。

备份时先停止服务，再复制完整数据目录，避免 SQLite 写入中备份不一致：

```bash
docker compose stop trendpublish
docker compose cp trendpublish:/app/src/temp ./backup-article-data
docker compose start trendpublish
```

另行安全备份 `config` 目录；不要只备份文章 HTML
而遗漏数据库和发送占位。选择不存在的备份目录名，避免覆盖旧备份。

升级提醒：旧版的宿主机 `data/temp` 或原生运行的 `src/temp`
不会自动迁入新数据卷。已有生产数据时先停旧服务、备份并完成迁移，再启动定时；原目录不会被删除。

## 常见问题

- Docker 引擎未就绪：先启动 Docker Desktop，再执行 `status`。
- 缺少 `SERVER_API_KEY` 或 `AI_API_KEY`：填写 `config/runtime.env` 后执行
  `restart`。
- 端口 8000 被占用：停止占用程序，或修改 Compose 左侧宿主机端口；容器内端口仍是
  8000。
- 容器变为 unhealthy：查看
  `logs`；缺配置时程序以非零状态退出，不会假装启动成功。
- 来源格式错误：检查 `runtime.env` 中 `ARTICLE_SOURCES`
  的等号右侧是否重复了变量名。 修正后执行 `restart`，不需要删除数据库或数据卷。
- 旧版本初始化中断：新版本会保留已有编辑并补齐缺失配置；恢复出的定时任务默认暂停，
  请在后台核对来源、授权和仅预览设置后再自行启用。
- 修改主题配置后未生效：执行
  `restart`。后台已有方案和定时规则仍以数据库为准，应在后台修改。
- Mac 休眠后定时不执行：Docker
  不会让休眠电脑继续运行，长期任务请放到常驻服务器。

本版默认仅预览和草稿模式，不会因启动容器就自动公开发表。正式发表仍须完成公众号权限、自有封面及平台
AI 内容标识核验，参见 [定时自动发表](automatic-publishing.md)。
