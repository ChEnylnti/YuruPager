import type { ReactNode } from "react";
import { useMemo } from "react";

import { lexer, type Token, type Tokens } from "marked";
import { markdownText } from "./i18n.js";

/**
 * Render model output as a small, safe Markdown surface. The renderer walks
 * Marked's token tree instead of injecting generated HTML, so raw HTML and
 * untrusted URLs never become executable DOM.
 */
export function MarkdownMessage({ source }: { source: string }) {
  const blocks = useMemo(() => {
    try {
      return lexer(unwrapCodexEnvelope(source), { gfm: true, breaks: true });
    } catch {
      return null;
    }
  }, [source]);

  if (blocks === null) return <p className="message-plain">{source}</p>;
  return <div className="markdown-content">{renderBlocks(blocks)}</div>;
}

function unwrapCodexEnvelope(source: string): string {
  // Codex can wrap an assistant reply in protocol-only tags. If left in place,
  // marked treats the whole reply as an HTML block and hides its Markdown tree.
  const withoutOpening = source.replace(/^(?:\s*<(?:message|heartbeat)(?:\s[^>]*)?>)+/iu, "");
  return withoutOpening.replace(/(?:<\/(?:message|heartbeat)>\s*)+$/iu, "");
}

export function renderBlocks(tokens: Token[]): ReactNode[] {
  return tokens.map((token, index) => renderBlock(token, `block-${index}`)).filter((value) => value !== null);
}

function renderBlock(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "heading": {
      const heading = token as Tokens.Heading;
      const Tag = heading.depth <= 1 ? "h4" : heading.depth === 2 ? "h5" : "h6";
      return <Tag key={key}>{renderInline(heading.tokens, `${key}-inline`)}</Tag>;
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return <p key={key}>{renderInline(paragraph.tokens, `${key}-inline`)}</p>;
    }
    case "text": {
      const text = token as Tokens.Text;
      return <p key={key}>{text.tokens === undefined ? text.text : renderInline(text.tokens, `${key}-inline`)}</p>;
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      return <blockquote key={key}>{renderBlocks(quote.tokens)}</blockquote>;
    }
    case "code": {
      const code = token as Tokens.Code;
      return (
        <pre key={key} className="markdown-code-block">
          <code data-language={code.lang ?? undefined}>{code.text}</code>
        </pre>
      );
    }
    case "list": {
      const list = token as Tokens.List;
      const Tag = list.ordered ? "ol" : "ul";
      return (
        <Tag key={key} start={list.ordered && list.start !== "" && list.start !== 1 ? list.start : undefined}>
          {list.items.map((item, itemIndex) => renderListItem(item, `${key}-item-${itemIndex}`))}
        </Tag>
      );
    }
    case "table": {
      const table = token as Tokens.Table;
      return (
        <div key={key} className="markdown-table-scroll" role="region" aria-label={markdownText.tableRegionAria} tabIndex={0}>
          <table>
            <thead>
              <tr>{table.header.map((cell, cellIndex) => renderTableCell(cell, table.align[cellIndex], `${key}-head-${cellIndex}`, true))}</tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => renderTableCell(cell, table.align[cellIndex], `${key}-row-${rowIndex}-${cellIndex}`, false))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "hr":
      return <hr key={key} />;
    case "html": {
      const html = token as Tokens.HTML;
      return <p key={key} className="markdown-unsupported">{html.text}</p>;
    }
    default:
      return fallbackToken(token, key);
  }
}

function renderListItem(item: Tokens.ListItem, key: string): ReactNode {
  return (
    <li key={key}>
      {item.tokens.map((token, index) => {
        if (token.type === "checkbox") {
          const checkbox = token as Tokens.Checkbox;
          return <input key={`${key}-checkbox-${index}`} type="checkbox" checked={checkbox.checked} disabled aria-label={checkbox.checked ? markdownText.checkboxCheckedAria : markdownText.checkboxUncheckedAria} />;
        }
        if (token.type === "list") return renderBlock(token, `${key}-nested-${index}`);
        if (token.type === "paragraph") {
          const paragraph = token as Tokens.Paragraph;
          return <span key={`${key}-paragraph-${index}`}>{renderInline(paragraph.tokens, `${key}-paragraph-${index}`)}</span>;
        }
        if (token.type === "text") {
          const text = token as Tokens.Text;
          return <span key={`${key}-text-${index}`}>{text.tokens === undefined ? text.text : renderInline(text.tokens, `${key}-text-${index}`)}</span>;
        }
        return renderBlock(token, `${key}-block-${index}`);
      })}
    </li>
  );
}

function renderTableCell(cell: Tokens.TableCell, alignment: Tokens.TableCell["align"] | undefined, key: string, header: boolean): ReactNode {
  const Tag = header ? "th" : "td";
  return <Tag key={key} style={{ textAlign: alignment ?? undefined }}>{renderInline(cell.tokens, `${key}-inline`)}</Tag>;
}

function renderInline(tokens: Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => renderInlineToken(token, `${keyPrefix}-${index}`)).filter((value) => value !== null);
}

function renderInlineToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens === undefined ? text.text : <span key={key}>{renderInline(text.tokens, `${key}-nested`)}</span>;
    }
    case "escape":
      return (token as Tokens.Escape).text;
    case "strong": {
      const strong = token as Tokens.Strong;
      return <strong key={key}>{renderInline(strong.tokens, `${key}-nested`)}</strong>;
    }
    case "em": {
      const emphasis = token as Tokens.Em;
      return <em key={key}>{renderInline(emphasis.tokens, `${key}-nested`)}</em>;
    }
    case "del": {
      const deleted = token as Tokens.Del;
      return <del key={key}>{renderInline(deleted.tokens, `${key}-nested`)}</del>;
    }
    case "codespan":
      return <code key={key} className="markdown-inline-code">{(token as Tokens.Codespan).text}</code>;
    case "br":
      return <br key={key} />;
    case "link": {
      const link = token as Tokens.Link;
      const href = safeMarkdownHref(link.href);
      const content = renderInline(link.tokens, `${key}-nested`);
      return href === null
        ? <span key={key}>{content}</span>
        : <a key={key} href={href} title={link.title ?? undefined} target="_blank" rel="noreferrer noopener">{content}</a>;
    }
    case "image": {
      const image = token as Tokens.Image;
      return <span key={key} className="markdown-image-placeholder">{markdownText.imagePlaceholder(image.text)}</span>;
    }
    case "html":
      return <span key={key}>{(token as Tokens.HTML).text}</span>;
    case "checkbox":
      return <input key={key} type="checkbox" checked={(token as Tokens.Checkbox).checked} disabled aria-label={(token as Tokens.Checkbox).checked ? markdownText.checkboxCheckedAria : markdownText.checkboxUncheckedAria} />;
    default: {
      const generic = token as Tokens.Generic;
      if (Array.isArray(generic.tokens)) return <span key={key}>{renderInline(generic.tokens, `${key}-nested`)}</span>;
      return typeof generic.text === "string" ? generic.text : typeof generic.raw === "string" ? generic.raw : null;
    }
  }
}

function fallbackToken(token: Token, key: string): ReactNode {
  const generic = token as Tokens.Generic;
  if (Array.isArray(generic.tokens)) return <div key={key}>{renderInline(generic.tokens, `${key}-inline`)}</div>;
  if (typeof generic.text === "string") return <p key={key}>{generic.text}</p>;
  return null;
}

function safeMarkdownHref(value: string): string | null {
  const href = value.trim();
  if (href.startsWith("#")) return href;
  try {
    const url = new URL(href, "https://yurupager.invalid");
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}
