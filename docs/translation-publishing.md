# 全文翻译与发布配置

先核实来源授权并配置账号，之后可按计划自动执行。无合格文章时，本轮不发。

## 基础服务

复制 `trendpublish.config.example.ts` 为
`trendpublish.config.ts`，配置后台访问密钥、`providers.ai` 模型、Jina 或
Firecrawl 全文抓取服务、公众号凭证以及服务器出口 IP 白名单。数据源写入
`features.article.sources`，路由写入
`fetchGroups`。遵守来源网站访问要求，不绕过付费墙，不将密钥提交到版本库。

## 翻译策略与授权

以下片段位于 `features.article`
内。域名、作者和授权均为占位示例，不代表已经取得许可：

```ts
translation: {
  mode: "translation",
  allowedTopics: ["编程教程", "AI 工具使用", "效率工具", "产品设计"],
  blockedTopics: ["加密货币炒作"],
  glossary: { workflow: "工作流" },
  maxCandidates: 5,
  maxSourceChars: 24000,
  chunkChars: 2500,
  minQualityScore: 80,
  coverMediaId: "",
  platformDisclosureConfirmed: false,
  grants: [{
    id: "verified-article",
    url: "https://example.org/tutorials/your-article",
    match: "exact",
    author: "填写原作者",
    license: "permission",
    evidenceUrl: "https://example.org/reuse-permission",
    confirmed: false,
    // expiresAt: "2027-01-01T00:00:00Z",
  }],
},
```

`grants`
由运营者核实维护。模型不会根据网页自称“已授权”自动放行；核实许可允许本次中文翻译、公众号发布及实际使用方式后，才把
`confirmed` 改为 `true`。

- `exact`：仅匹配这一篇完整 URL，查询参数也参与匹配。
- `prefix`：仅匹配同域名目录，地址必须以 `/`
  结尾且无查询参数。只有目录内所有文章确属同一作者和已核实许可时才使用。
- `license`：支持 `CC-BY-4.0`、`CC0-1.0` 或明确的
  `permission`。字段本身不证明有转载权，其他许可本版本不自动推断。
- `evidenceUrl`：公开许可依据，不要填写私密邮件、凭据或私人信息。
- `expiresAt`：可选到期时间，到期拒绝；发送前再检查一次。

来源许可不自动覆盖第三方配图。本版不复制原文图片，保留署名、来源、许可和 AI
翻译说明，也不标为账号原创。

固定排除主题不可清空，只能追加。部署配置修改后重启；已有后台来源、方案、定时规则另存数据库，需要在后台修改。后台旧质量门禁和“强制发布”不能覆盖翻译安全策略。

## 预览与检查

```bash
deno task doctor
deno task article --dry-run
```

后台运行产物包括：`translation-policy.json`、`source-*.json`、`source-review-*.json`、逐段
`translation-*.json`、`translation-rejections.json`、`translation-selection.json`、`19-final-article.html`、`dry-run-preview.html`
和 `14-publish-result.json`。

默认最多审查 5
篇已授权候选，按质量分尝试翻译，选择首篇通过全部检查的文章。候选上限
20；原文默认上限 24000 字符、最高 40000；成稿 HTML 达 20000
字符时跳过。超过限制整篇跳过，不截断。译文数字、行内代码由程序核对，代码围栏保留原样，模型另外做源译对照。

模型无工具权限，网页内容视作不可信数据；抓取不完整、JSON
无效、输出截断、审核不确定或翻译核验失败时均拒绝。自动审核不能保证零漏判或零误译，先检查样本并定期抽检。原文会保存到运行产物，需控制访问、备份并安排留存周期。

## 正式发表

1. 上传并检查本账号的自有封面，填写 `translation.coverMediaId`。
2. 核实本账号、接口和实际发布方式满足平台 AI 内容标识要求，完成对应设置后才确认
   `platformDisclosureConfirmed: true`。此字段不替代平台标识操作，不会自动设置未实现的微信标识字段；不能只凭正文声明认定已满足全部要求。无法确认时继续预览。
3. 在文章方案将发表模式设为 `publish`；`draft`
   只创建草稿。关闭本次运行或定时的仅预览。
4. 使用持久化本地/Docker 存储常驻运行，详见
   [定时自动发表](automatic-publishing.md)。定时表示开始处理，不保证准点公开。

历史的摘要、AI
配图、模板和向量去重不参与全文译刊分支，每轮只处理一篇成稿。后台部分旧质量统计仍属于历史组稿流程，译刊以翻译运行产物为准。

## 失败与恢复

不合格文章本轮拦截，后续计划继续。发送前原子占用原文 URL 与正文指纹，按公众号
appId 隔离，不同后台别名不能绕过去重。

发送超时、响应丢失或写入失败时不自动释放占位。先核对公众号后台和本次发布结果，再决定人工恢复；不要批量清空
`translation-claims/`。备份整个数据目录，保持结果与占位一致。

Cloudflare R2/KV
适配器尚无原子占位支持，真实译刊发送会拒绝执行；本版正式运行使用本地/Docker。内存适配器仅供测试，生产不可替换持久化存储。

升级后默认模式为 `translation`，空授权列表不会转载文章。历史组稿可设
`mode: "editorial-preview"`
继续预览，但不能真实发送。升级前备份并检查已有定时规则。
