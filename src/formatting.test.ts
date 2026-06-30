import { describe, expect, test } from "bun:test";
import { balanceTelegramHtml, convertMarkdownToHtml } from "./formatting";

/**
 * Telegram accepts nested inline tags but rejects overlap or stray closes.
 * This mirrors (loosely) what Telegram's parser checks: walk the tags and
 * ensure every close matches the most-recently-opened still-open tag, and that
 * nothing is left open.
 */
function isValidTelegramHtml(html: string): boolean {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (!closing) {
      stack.push(name);
    } else {
      if (stack[stack.length - 1] !== name) return false; // overlap or stray
      stack.pop();
    }
  }
  return stack.length === 0;
}

describe("balanceTelegramHtml", () => {
  test("fixes overlapping b/i tags (close-inner-first)", () => {
    const out = balanceTelegramHtml("<b>homo<i>computatis</b>: rest</i>");
    expect(isValidTelegramHtml(out)).toBe(true);
    expect(out).toBe("<b>homo<i>computatis</i></b>: rest");
  });

  test("drops a stray close tag with no matching open", () => {
    const out = balanceTelegramHtml("<b>consciousness</i>as<i>pattern</i>flow</b>");
    expect(isValidTelegramHtml(out)).toBe(true);
    expect(out).toBe("<b>consciousnessas<i>pattern</i>flow</b>");
  });

  test("closes unclosed tags at the end", () => {
    const out = balanceTelegramHtml("<b>bold and <i>italic");
    expect(isValidTelegramHtml(out)).toBe(true);
    expect(out).toBe("<b>bold and <i>italic</i></b>");
  });

  test("preserves attributes on open tags (links)", () => {
    const out = balanceTelegramHtml('<a href="https://x.com">link</a>');
    expect(out).toBe('<a href="https://x.com">link</a>');
  });

  test("leaves already-valid nested html untouched", () => {
    const valid = "<b>a <i>b</i> c</b>";
    expect(balanceTelegramHtml(valid)).toBe(valid);
  });

  test("handles overlap inside a blockquote without leaving empties", () => {
    const out = balanceTelegramHtml(
      "<blockquote><b>homo<i>computatis</b>: x</blockquote>"
    );
    expect(isValidTelegramHtml(out)).toBe(true);
    expect(out).toBe(
      "<blockquote><b>homo<i>computatis</i></b>: x</blockquote>"
    );
  });
});

describe("convertMarkdownToHtml — always emits valid Telegram HTML", () => {
  test("snake_case identifiers inside bold do not break tag nesting", () => {
    // Regression for daily-synthesis 400: "Unmatched end tag, expected </b>, found </i>"
    const md =
      "**1. consciousness_as_pattern_flow** and **arrows_over_objects** ok";
    const out = convertMarkdownToHtml(md);
    expect(isValidTelegramHtml(out)).toBe(true);
  });

  test("blockquote with snake_case bold/italic stays valid", () => {
    const md = "> **homo_computatis**: 의식 = 계산";
    const out = convertMarkdownToHtml(md);
    expect(isValidTelegramHtml(out)).toBe(true);
  });

  test("the reported daily-synthesis fragment converts to valid html", () => {
    const md = [
      "**🔥 발견**",
      "",
      "> homo_computatis: 자기 수정 프로토콜",
      "",
      "**1. The Log Is The Agent = consciousness_as_pattern_flow**",
      "**2. arrows_over_objects → harness**",
      "**3. particles_as_excitations → field**",
    ].join("\n");
    const out = convertMarkdownToHtml(md);
    expect(isValidTelegramHtml(out)).toBe(true);
  });
});

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

  test("single *asterisk* is italic, not bold (standard markdown)", () => {
    const out = convertMarkdownToHtml("this is *emphasis* here");
    expect(out).toContain("<i>emphasis</i>");
    expect(out).not.toContain("<b>emphasis</b>");
    expect(out).not.toContain("*");
  });

  test("double **asterisks** stay bold even with single-asterisk rule", () => {
    const out = convertMarkdownToHtml("**strong** and *weak*");
    expect(out).toContain("<b>strong</b>");
    expect(out).toContain("<i>weak</i>");
  });

  test("converts ~~strikethrough~~ to <s>", () => {
    const out = convertMarkdownToHtml("this is ~~gone~~ now");
    expect(out).toContain("<s>gone</s>");
    expect(out).not.toContain("~~");
    expect(isValidTelegramHtml(out)).toBe(true);
  });

  test("converts ||spoiler|| to <tg-spoiler>", () => {
    const out = convertMarkdownToHtml("the answer is ||42|| ok");
    expect(out).toContain("<tg-spoiler>42</tg-spoiler>");
    expect(out).not.toContain("||");
    expect(isValidTelegramHtml(out)).toBe(true);
  });

  test("strike/spoiler nested with bold stay valid Telegram HTML", () => {
    const out = convertMarkdownToHtml("**bold ~~struck~~** and ||**secret**||");
    expect(isValidTelegramHtml(out)).toBe(true);
    expect(out).toContain("<s>");
    expect(out).toContain("<tg-spoiler>");
  });
});

describe("convertMarkdownToHtml — code blocks", () => {
  test("preserves fenced code block language as <pre><code class=language-X>", () => {
    const md = "```python\nprint('hi')\n```";
    const out = convertMarkdownToHtml(md);
    expect(out).toContain('<pre><code class="language-python">');
    expect(out).toContain("</code></pre>");
    expect(out).toContain("print('hi')"); // content survives unescaped
  });

  test("fenced code without language stays a plain <pre>", () => {
    const md = "```\nplain code\n```";
    const out = convertMarkdownToHtml(md);
    expect(out).toContain("<pre>plain code");
    expect(out).not.toContain('class="language-');
  });

  test("escapes html-special chars inside code blocks", () => {
    const md = "```html\n<div>&amp;</div>\n```";
    const out = convertMarkdownToHtml(md);
    expect(out).toContain("&lt;div&gt;");
    expect(out).not.toContain("<div>");
    expect(isValidTelegramHtml(out)).toBe(true);
  });

  test("does not apply markdown styling inside code blocks", () => {
    const md = "```\n**not bold** _not italic_\n```";
    const out = convertMarkdownToHtml(md);
    expect(out).toContain("**not bold**");
    expect(out).not.toContain("<b>not bold</b>");
  });
});

describe("convertMarkdownToHtml — blockquotes", () => {
  test("short blockquote is a plain <blockquote>", () => {
    const out = convertMarkdownToHtml("> one line quote");
    expect(out).toContain("<blockquote>");
    expect(out).not.toContain("expandable");
  });

  test("long multi-line blockquote becomes expandable", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `> line ${i + 1}`);
    const out = convertMarkdownToHtml(lines.join("\n"));
    expect(out).toContain("<blockquote expandable>");
    expect(isValidTelegramHtml(out)).toBe(true);
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
