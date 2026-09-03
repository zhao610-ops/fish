# 公众号自动译刊

面向自有微信公众号的英文文章自动翻译与定时发布系统。当前名称为内部暂定名称，未设置官网、社群或对外联系方式。

从配置的数据源发现文章、抓取全文，限制主题，完整翻译为中文，核对译文，排版后提交公众号普通发表。不向粉丝群发。

## 自动处理流程

发现候选 → 获取全文 → 完整性、主题与质量审核 → 分段翻译 → 源译对照 → 成稿审核 →
去重占位 → 微信发表 → 查询结果。

- 允许主题可配置，例如编程教程、AI 工具使用、效率工具、产品设计。
- 固定排除政治、国际关系、军事、仇恨、色情等风险主题；可追加，不能清空基础限制。
- 原文和成稿全文审核，不截取开头代替全文；不确定、抓取失败、翻译核验失败时跳过，不降级成摘要继续发布。
- 每轮最多选一篇通过检查的文章，优先尝试质量分较高的候选。
- 保留原文链接、可获得的作者信息和 AI
  翻译说明；缺失作者时提示参见原文，不编造许可，不转载第三方图片，不标成账号原创。
- 使用本账号已检查的自有封面，正文固定排版，采用微软雅黑字体。
- 按公众号账号记录原文 URL
  和正文指纹，原子占位防止并发重复提交；发送超时不自动重发。
- 后台可查看原文、审核、逐段译文、拒绝原因和发表结果。

自动审核仍有漏判风险，不承诺敏感内容零漏检或译文绝对准确。建议先使用小范围授权来源试运行并定期抽检。

## 快速开始

推荐使用 Docker，宿主机无需安装 Deno 或 Node.js。Mac 上先启动 Docker Desktop。
模型与全文抓取服务需要自行配置，正式发表还需要具备对应接口权限的公众号。

在本项目目录执行：

```bash
sh scripts/docker.sh init
# 填写 config 目录中的密钥、来源与自有封面
sh scripts/docker.sh up
sh scripts/docker.sh doctor
sh scripts/docker.sh preview
```

示例默认仅预览，不会直接发表。完整步骤见 [Docker 运行指南](docs/docker.md) 和
[全文翻译与发布配置](docs/translation-publishing.md)。

预览通过后，填写自有封面素材 ID，核实平台 AI
标识要求，在后台将文章方案设为公开发表，再启用定时并关闭该规则的“仅预览”。参见
[定时自动发表](docs/automatic-publishing.md)。

```bash
# 查看容器状态和日志
sh scripts/docker.sh status
sh scripts/docker.sh logs

# 修改配置后重建容器，保留数据
sh scripts/docker.sh restart

# 停止，不删除数据卷
sh scripts/docker.sh stop
```

Docker 后台为 `http://localhost:8000/dashboard/`，默认只监听本机。
后台访问密钥由自己设置。文章、数据库和发送占位保存在 Docker
持久化数据卷中，停止或重建容器不会清空。

保留原生开发方式：安装 Deno 2，复制根目录配置示例并填写后执行
`deno task dev`；开发后台为 `http://localhost:5173/dashboard/`。

## 关键配置

| 配置项                                       | 用途                                 |
| -------------------------------------------- | ------------------------------------ |
| `providers.ai`                               | 兼容 Chat Completions 的模型服务     |
| `providers.fetch.jina` / `firecrawl`         | 全文抓取，至少配置一种               |
| `features.article.sources`                   | 发现候选的数据源                     |
| `features.article.translation.allowedTopics` | 允许主题                             |
| `features.article.translation.blockedTopics` | 追加排除主题                         |
| `features.article.translation.glossary`      | 术语译法                             |
| `features.article.translation.coverMediaId`  | 本账号的自有封面                     |
| `features.article.publisher.mode`            | `draft` 草稿，`publish` 正式发表     |
| `features.article.dryRun`                    | 默认仅预览；运行或定时的预览设置优先 |

基础主题策略由部署配置管理，修改后重启服务。后台维护来源、账号与定时，不覆盖部署侧翻译策略；旧质量开关和“强制发布”不能绕过新流程。

## 当前边界

- 正式译刊支持本地/Docker 持久化存储。Cloudflare
  存储暂不支持原子占位，真实发送会被阻止。
- 项目不要求填写授权表或 AI
  标识人工确认开关；来源使用权和平台声明要求由运营者另行处理，不代表平台审核一定通过。
- 付费墙、不完整正文、超长文章均跳过。
- 定时是开始处理时间，最终公开时间取决于处理和微信审核，不保证准点。
- 历史摘要组稿保留为 `editorial-preview` 模式，仅允许预览。
- 不包含图片翻译、付费墙绕过和粉丝群发。
- 是否能正式发表以账号权限和真实接口返回为准；本地测试不代表微信已经接通。

## 代码位置

- `src/features/weixin-article/domain/translation-policy.ts`：主题与翻译策略。
- `src/features/weixin-article/services/translation.service.ts`：全文检查、翻译、核验、去重。
- `src/features/weixin-article/workflow.ts`：工作流和发布门禁。
- `src/app/weixin-article/article-schedule-runner.ts`：定时调度。
- `src/app/weixin-article/reconcile-publications.ts`：发表结果查询。
- `dashboard/`：账号、方案、定时和运行产物后台。

## 许可

本项目基于开源代码定制，保留必要的第三方许可与版权声明，详见
[LICENSE](LICENSE)。名称和业务说明的调整不改变原代码版权归属。
