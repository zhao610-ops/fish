import { Marked } from "npm:marked@^15.0.6";

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monthPattern = months.map((month) =>
  month === "May" ? month : `${month}|${month.slice(0, 3)}\\.?`
).join("|");
const monthNumber = (name: string) =>
  months.findIndex((month) =>
    month.toLowerCase().startsWith(name.replace(/\.$/, "").toLowerCase())
  ) + 1;

/** 只规范化日期表达；版本、金额、百分比以及日期的实际年月日仍严格比较。 */
export function normalizeTranslationDates(text: string): string {
  const date = (year: string, month: number, day: string) =>
    `DATE_${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
  return text
    .replace(
      new RegExp(
        `\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(\\d{4})\\b`,
        "gi",
      ),
      (_all, month, day, year) => date(year, monthNumber(month), day),
    )
    .replace(
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})\\s*,?\\s+(\\d{4})\\b`,
        "gi",
      ),
      (_all, day, month, year) => date(year, monthNumber(month), day),
    )
    .replace(
      /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g,
      (_all, year, month, day) => date(year, Number(month), day),
    )
    .replace(
      /\b(\d{4})-(\d{2})-(\d{2})\b/g,
      (_all, year, month, day) => date(year, Number(month), day),
    )
    .replace(
      new RegExp(`\\b(${monthPattern})\\s+(\\d{4})\\b`, "gi"),
      (_all, month, year) =>
        `MONTH_${year}-${String(monthNumber(month)).padStart(2, "0")}`,
    )
    .replace(
      /(\d{4})\s*年\s*(\d{1,2})\s*月/g,
      (_all, year, month) =>
        `MONTH_${year}-${String(Number(month)).padStart(2, "0")}`,
    );
}

export function translationLiterals(
  markdown: string,
): { numbers: string[]; links: string[]; code: string[] } {
  const parser = new Marked();
  const text: string[] = [];
  const links: string[] = [];
  const code: string[] = [];
  parser.walkTokens(parser.lexer(markdown), (token) => {
    if (token.type === "link") links.push(token.href);
    if (token.type === "codespan" || token.type === "code") {
      code.push(token.text);
    }
    if (token.type === "image" && !("tokens" in token && token.tokens)) {
      text.push(token.text);
    }
    if (
      (token.type === "text" || token.type === "escape") &&
      !("tokens" in token && token.tokens)
    ) text.push(token.text);
    if (token.type === "html") text.push(token.text);
  });
  // 链接 URL 和代码单独校验，避免把跟踪参数中的 %20 当正文数字。
  const visible = normalizeTranslationDates(text.join(" ")).replace(/％/g, "%");
  return {
    numbers: (visible.match(/\d+(?:[.,:/-]\d+)*(?:%)?/g) ?? []).sort(),
    links: links.sort(),
    code: code.sort(),
  };
}
