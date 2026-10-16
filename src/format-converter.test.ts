import { parseMarkdown, stringifyMarkdown } from "chat";
import { describe, expect, it } from "vitest";
import { WWebJSFormatConverter } from "./format-converter";

const converter = new WWebJSFormatConverter();
const render = (markdown: string) => converter.fromAst(parseMarkdown(markdown));

describe("WWebJSFormatConverter", () => {
  describe("fromAst", () => {
    it("renders WhatsApp inline markup", () => {
      expect(render("**bold**")).toBe("*bold*");
      expect(render("_italic_")).toBe("_italic_");
      expect(render("~~gone~~")).toBe("~gone~");
      expect(render("`code`")).toBe("`code`");
    });

    it("renders headings as bold, since WhatsApp has none", () => {
      expect(render("# Title")).toBe("*Title*");
    });

    it("renders links as text followed by the URL", () => {
      expect(render("[Chat SDK](https://chat-sdk.dev)")).toBe("Chat SDK (https://chat-sdk.dev)");
    });

    it("keeps fenced code on its own lines", () => {
      expect(render("```\nconst a = 1;\n```")).toBe("```\nconst a = 1;\n```");
    });

    it("prefixes every line of a blockquote", () => {
      expect(render("> first\n>\n> second")).toBe("> first\n> \n> second");
    });

    it("renders ordered and unordered lists", () => {
      expect(render("- one\n- two")).toContain("one");
      expect(render("1. one\n2. two")).toContain("one");
    });

    it("renders tables as ASCII inside a code block", () => {
      const output = render("| a | b |\n| - | - |\n| 1 | 2 |");
      expect(output.startsWith("```\n")).toBe(true);
      expect(output).toContain("a");
      expect(output).toContain("2");
    });
  });

  describe("toAst", () => {
    it("reads WhatsApp bold and strikethrough back as Markdown", () => {
      expect(stringifyMarkdown(converter.toAst("*bold*")).trim()).toBe("**bold**");
      expect(stringifyMarkdown(converter.toAst("~gone~")).trim()).toBe("~~gone~~");
    });

    it("leaves already-doubled markers alone", () => {
      expect(stringifyMarkdown(converter.toAst("**bold**")).trim()).toBe("**bold**");
    });

    it("round-trips inline markup through the AST", () => {
      expect(converter.fromAst(converter.toAst("*bold* and _italic_"))).toBe("*bold* and _italic_");
    });

    it("keeps a bare asterisk as literal text", () => {
      expect(converter.toAst("2 * 3 = 6")).toBeTruthy();
      expect(converter.extractPlainText("2 * 3 = 6")).toContain("2");
    });
  });

  describe("renderPostable", () => {
    it("passes raw strings through untouched", () => {
      expect(converter.renderPostable("**not markdown**")).toBe("**not markdown**");
    });

    it("converts markdown payloads to WhatsApp markup", () => {
      expect(converter.renderPostable({ markdown: "**bold**" })).toBe("*bold*");
    });
  });

  it("keeps text from anyone plain rather than stalling or throwing on it", () => {
    const converter = new WWebJSFormatConverter();
    expect(() => converter.toAst("> ".repeat(8000))).not.toThrow();

    const started = Date.now();
    const ast = converter.toAst("*a".repeat(32_000));
    expect(Date.now() - started).toBeLessThan(200);
    expect(ast.type).toBe("root");
  });
});
