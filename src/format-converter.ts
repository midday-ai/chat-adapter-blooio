/**
 * Plain-text format converter for iMessage via Blooio.
 *
 * iMessage is a plain-text platform — markdown bold/italic/links are not
 * rendered natively. Outbound messages strip all formatting. Inbound messages
 * are treated as plain text.
 */

/**
 * Strip markdown-style formatting for Blooio outbound messages.
 * Preserves newlines and URLs but removes bold, italic, code fences, etc.
 */
export function toPlainText(text: string): string {
  const urlPlaceholders: string[] = [];

  let result = text
    .replace(/https?:\/\/[^\s)>\]]+/g, (url) => {
      urlPlaceholders.push(url);
      return `%%URLPH${urlPlaceholders.length - 1}%%`;
    })
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```(\w*\n?)?/g, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*_]{3,}$/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "• ")
    .trim();

  result = result.replace(
    /%%URLPH(\d+)%%/g,
    (_, idx) => urlPlaceholders[Number(idx)]!,
  );

  return result;
}
