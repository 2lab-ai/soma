import { describe, expect, test } from "bun:test";
import { convertMarkdownToHtml } from "./formatting";

describe("convertMarkdownToHtml — inline styling", () => {
  test("renders bold, headers and links as Telegram HTML (not raw markdown)", () => {
    const out = convertMarkdownToHtml(
      "## Title\n**bold** and [link](https://x.com)"
    );
    expect(out).toContain("<b>Title</b>");
    expect(out).toContain("<b>bold</b>");
    expect(out).toContain('<a href="https://x.com">link</a>');
    expect(out).not.toContain("**");
    expect(out).not.toContain("## ");
  });

  test("drops horizontal rules", () => {
    const out = convertMarkdownToHtml("above\n---\nbelow");
    expect(out).not.toContain("---");
    expect(out).toContain("above");
    expect(out).toContain("below");
  });
});

describe("convertMarkdownToHtml — tables", () => {
  test("converts a markdown table into a <pre> block without pipes/separators", () => {
    const md = [
      "| 항목 | 상태 | 금액 |",
      "|------|------|------|",
      "| Keychron | 주문완료 | ₩345K |",
      "| **ROG Z13** | **배송지연** | ₩4.4M |",
    ].join("\n");

    const out = convertMarkdownToHtml(md);

    expect(out).toContain("<pre>");
    expect(out).toContain("</pre>");
    // Separator row must be gone.
    expect(out).not.toContain("------");
    // Emphasis markers inside cells must be stripped (no dangling ** in <pre>).
    expect(out).not.toContain("**");
    // Cell content survives.
    expect(out).toContain("Keychron");
    expect(out).toContain("ROG Z13");
    expect(out).toContain("배송지연");
    expect(out).toContain("₩4.4M");
  });

  test("aligns columns with padding inside the <pre> block", () => {
    const md = [
      "| a | bb |",
      "|---|----|",
      "| ccc | d |",
    ].join("\n");

    const out = convertMarkdownToHtml(md);
    const pre = out.slice(out.indexOf("<pre>") + 5, out.indexOf("</pre>"));
    const rows = pre.split("\n");
    // Header cell "a" is padded to the width of "ccc" (3) → "a  ".
    expect(rows[0]).toBe("a    bb");
    expect(rows[1]).toBe("ccc  d");
  });

  test("leaves non-table pipe text untouched (no false positives)", () => {
    const out = convertMarkdownToHtml("use a | b shell pipe");
    expect(out).not.toContain("<pre>");
    expect(out).toContain("use a | b shell pipe");
  });

  test("renders the shopping-list-check style report cleanly", () => {
    const md = [
      "**📦 배송/주문 현황**",
      "",
      "| 항목 | 상태 | ETA | 금액 |",
      "|------|------|-----|------|",
      "| Keychron Q1 Max | 주문완료 | 미정 | ₩345K |",
      "| **ASUS ROG Flow Z13** | **배송지연** ⚠️ | **7월 초** | **₩4.4M** |",
    ].join("\n");

    const out = convertMarkdownToHtml(md);
    expect(out).toContain("<b>📦 배송/주문 현황</b>");
    expect(out).toContain("<pre>");
    expect(out).not.toContain("|------|");
    expect(out).not.toContain("**");
  });
});
