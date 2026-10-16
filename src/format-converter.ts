import {
  BaseFormatConverter,
  getNodeChildren,
  parseMarkdown,
  tableToAscii,
  type Content,
  type Root,
} from "chat";

const MAX_MARKDOWN_LENGTH = 16_000;

function plain(value: string): Root {
  return { children: [{ children: [{ type: "text", value }], type: "paragraph" }], type: "root" };
}

/**
 * Converts between WhatsApp's markup and the Chat SDK's mdast AST.
 *
 * WhatsApp understands `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``,
 * ` ```blocks``` `, `> quotes` and simple lists. It has no link syntax, so
 * links render as `text (url)`, and no tables, so tables render as ASCII
 * inside a code block.
 */
export class WWebJSFormatConverter extends BaseFormatConverter {
  /** Text from anyone: past `MAX_MARKDOWN_LENGTH`, or when the parser gives up, it stays plain rather than stalling or throwing. */
  toAst(platformText: string): Root {
    if (platformText.length > MAX_MARKDOWN_LENGTH) return plain(platformText);
    try {
      return parseMarkdown(
        platformText
          .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, "**$1**")
          .replace(/(?<!~)~(?!~)([^~\n]+?)~(?!~)/g, "~~$1~~"),
      );
    } catch {
      return plain(platformText);
    }
  }

  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) => this.toWhatsApp(node));
  }

  private toWhatsApp(node: Content): string {
    switch (node.type) {
      case "blockquote":
        return this.join(node, "\n\n")
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      case "break":
        return "\n";
      case "code":
        return `\`\`\`\n${node.value}\n\`\`\``;
      case "delete":
        return `~${this.join(node)}~`;
      case "emphasis":
        return `_${this.join(node)}_`;
      case "heading":
        return `*${this.join(node)}*`;
      case "image":
        return node.url || this.join(node);
      case "inlineCode":
        return `\`${node.value}\``;
      case "link": {
        const text = this.join(node);
        // A bare URL or address is its own link; repeating it would print it twice.
        return !node.url || [text, `mailto:${text}`].includes(node.url)
          ? text
          : `${text} (${node.url})`;
      }
      case "list":
        return this.renderList(node, 0, (child) => this.toWhatsApp(child));
      case "strong":
        return `*${this.join(node)}*`;
      case "table":
        return `\`\`\`\n${tableToAscii(node)}\n\`\`\``;
      case "thematicBreak":
        return "──────────";
      default:
        return this.defaultNodeToText(node, (child) => this.toWhatsApp(child));
    }
  }

  private join(node: Content, separator = ""): string {
    return getNodeChildren(node)
      .map((child) => this.toWhatsApp(child))
      .join(separator);
  }
}
