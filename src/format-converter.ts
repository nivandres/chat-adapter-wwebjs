import {
  BaseFormatConverter,
  chartElementToFallbackText,
  getNodeChildren,
  parseMarkdown,
  tableElementToAscii,
  tableToAscii,
  type CardChild,
  type CardElement,
  type Content,
  type Root,
} from "chat";

const MAX_MARKDOWN_LENGTH = 16_000;
const DIVIDER = "──────────";

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
        return DIVIDER;
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

function childText(child: CardChild): string {
  switch (child.type) {
    case "text":
      return child.style === "bold"
        ? `*${child.content}*`
        : child.style === "muted"
          ? `_${child.content}_`
          : child.content;
    case "link":
      return `${child.label}: ${child.url}`;
    case "fields":
      return child.children.map(({ label, value }) => `*${label}:* ${value}`).join("\n");
    case "table":
      return `\`\`\`\n${tableElementToAscii(child.headers, child.rows)}\n\`\`\``;
    case "chart":
      return chartElementToFallbackText(child);
    case "section":
      return child.children.map(childText).filter(Boolean).join("\n");
    case "divider":
      return DIVIDER;
    default:
      return "";
  }
}

/** A card in WhatsApp's markup. Its images go out as media, and its buttons are an addon's to render. */
export function cardToText(card: CardElement): string {
  return [card.title && `*${card.title}*`, card.subtitle, ...card.children.map(childText)]
    .filter(Boolean)
    .join("\n");
}

/** Every image a card carries, its header first. */
export function cardImages(card: CardElement): string[] {
  const inside = (children: CardChild[]): string[] =>
    children.flatMap((child) =>
      child.type === "image" ? [child.url] : child.type === "section" ? inside(child.children) : [],
    );
  return [...(card.imageUrl ? [card.imageUrl] : []), ...inside(card.children)];
}
