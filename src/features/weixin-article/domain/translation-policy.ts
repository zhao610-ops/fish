/** 授权由运营者核实，网页正文或模型输出不能授予转载权限。 */
export interface TranslationSourceGrant {
  id: string;
  url: string;
  match: "exact" | "prefix";
  author: string;
  license: "CC-BY-4.0" | "CC0-1.0" | "permission";
  evidenceUrl: string;
  confirmed: boolean;
  expiresAt?: string;
}

export interface TranslationPolicy {
  /** 历史组稿模式只允许预览，不再允许绕过翻译安全流程发表。 */
  mode: "translation" | "editorial-preview";
  allowedTopics: string[];
  blockedTopics: string[];
  grants: TranslationSourceGrant[];
  glossary: Record<string, string>;
  maxCandidates: number;
  maxSourceChars: number;
  chunkChars: number;
  minQualityScore: number;
  /** 必须是本账号已上传并检查过的自有封面，不使用原项目的默认素材。 */
  coverMediaId: string;
  /** 运营者须核实当前账号和接口可以满足平台的生成内容标识要求。 */
  platformDisclosureConfirmed: boolean;
}

export const REQUIRED_BLOCKED_TOPICS = [
  "政治人物、政党、选举、政府政策、国际关系、制裁、地缘政治与领土争议",
  "战争、军事、武器、恐怖主义与极端主义",
  "宗教或族群冲突、仇恨歧视、色情、赌博、暴力及违法操作教程",
  "个人隐私泄露、医疗诊断、投资建议及重大社会争议事件",
];

export function resolveTranslationPolicy(
  input: Partial<TranslationPolicy> = {},
): TranslationPolicy {
  if (
    input.mode && !["translation", "editorial-preview"].includes(input.mode)
  ) {
    throw new Error("不支持的内容处理模式");
  }
  const allowedTopics = input.allowedTopics ??
    ["编程教程", "AI 工具使用", "效率工具", "产品设计"];
  if (
    !Array.isArray(allowedTopics) || !allowedTopics.length ||
    allowedTopics.some((x) => typeof x !== "string" || !x.trim())
  ) {
    throw new Error("必须配置非空的允许主题列表");
  }
  const additional = input.blockedTopics ?? [];
  if (
    !Array.isArray(additional) || additional.some((x) => typeof x !== "string")
  ) {
    throw new Error("排除主题必须是文本列表");
  }
  const grants = input.grants ?? [];
  if (!Array.isArray(grants)) throw new Error("授权来源必须是列表");
  for (const grant of grants) {
    safeSourceUrl(grant.url);
    safeSourceUrl(grant.evidenceUrl);
    if (
      !grant.id?.trim() || !grant.author?.trim() ||
      !["exact", "prefix"].includes(grant.match) ||
      !["CC-BY-4.0", "CC0-1.0", "permission"].includes(grant.license) ||
      typeof grant.confirmed !== "boolean"
    ) {
      throw new Error("授权项缺少编号、作者、匹配方式或支持的许可类型");
    }
    if (
      grant.match === "prefix" &&
      (!new URL(grant.url).pathname.endsWith("/") || new URL(grant.url).search)
    ) {
      throw new Error("目录授权地址必须以 / 结尾；单篇文章请使用 exact");
    }
    if (grant.expiresAt && !Number.isFinite(Date.parse(grant.expiresAt))) {
      throw new Error("授权到期时间无效");
    }
  }
  if (new Set(grants.map((g) => g.id)).size !== grants.length) {
    throw new Error("授权编号不能重复");
  }
  const glossary = input.glossary ?? {};
  if (
    !glossary || Array.isArray(glossary) || typeof glossary !== "object" ||
    Object.entries(glossary).some(([key, value]) =>
      !key.trim() || typeof value !== "string" || !value.trim()
    )
  ) {
    throw new Error("术语表必须是非空词条到中文译名的映射");
  }
  return {
    mode: input.mode ?? "translation",
    allowedTopics: allowedTopics.map((x) => x.trim()),
    blockedTopics: [...new Set([...REQUIRED_BLOCKED_TOPICS, ...additional])],
    grants,
    glossary,
    maxCandidates: bounded(input.maxCandidates, 5, 1, 20),
    maxSourceChars: bounded(input.maxSourceChars, 24000, 1000, 40000),
    chunkChars: bounded(input.chunkChars, 2500, 500, 4000),
    minQualityScore: bounded(input.minQualityScore, 80, 60, 100),
    coverMediaId: input.coverMediaId?.trim() ?? "",
    platformDisclosureConfirmed: input.platformDisclosureConfirmed === true,
  };
}

function bounded(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`数值必须在 ${min}～${max} 之间`);
  }
  return value;
}

/** 只接受公开 HTTPS 域名，不允许内网、IP 地址、凭据及编码路径绕过。 */
export function safeSourceUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    !host.includes(".") || /[:\[\]]/.test(host) || /^[\d.]+$/.test(host) ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
    /%2f|%5c|%2e/i.test(url.pathname)
  ) {
    throw new Error("来源必须是无凭据的公开 HTTPS 域名地址");
  }
  url.hash = "";
  return url;
}

export function findTranslationGrant(
  policy: TranslationPolicy,
  value: string,
  now = Date.now(),
): TranslationSourceGrant {
  const url = safeSourceUrl(value);
  const candidates = policy.grants.filter((grant) => {
    if (
      !grant.confirmed ||
      (grant.expiresAt && Date.parse(grant.expiresAt) <= now)
    ) return false;
    const scope = safeSourceUrl(grant.url);
    return scope.origin === url.origin &&
      (grant.match === "exact"
        ? scope.href === url.href
        : !scope.search && url.pathname.startsWith(scope.pathname));
  }).sort((a, b) => b.url.length - a.url.length);
  if (!candidates[0]) {
    throw new Error("文章不在已确认且有效的翻译转载授权范围内");
  }
  return candidates[0];
}

export async function translationKey(
  scope: string,
  value: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${scope}\n${value}`),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
