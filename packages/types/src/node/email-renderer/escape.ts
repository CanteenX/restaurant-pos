const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  // Braces too, so an escaped value can never form a `{{placeholder}}`.
  '{': '&#123;',
  '}': '&#125;',
};

/** Escapes text for use in HTML element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'{}]/g, (c) => HTML_ESCAPES[c]);
}
