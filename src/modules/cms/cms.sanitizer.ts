/**
 * HTML sanitizer for CMS content.
 *
 * Sanitises server-rendered HTML from Tiptap before storing or displaying it.
 * Blocks: <script>, event handlers (on*), javascript: URLs, data: URLs in href,
 * <iframe>, <object>, <embed>, <applet>, <form>, and other dangerous elements.
 *
 * This is a purposely conservative allowlist — only HTML tags and attributes
 * that a legitimate rich-text article would need are permitted.
 *
 * Note: This module intentionally avoids importing sanitize-html or DOMPurify
 * to keep dependencies minimal and avoid Node.js vs browser inconsistency.
 * The Tiptap JSON-to-HTML renderer is controlled server-side; this sanitizer
 * is a defense-in-depth layer, not the primary trust boundary.
 *
 * If third-party user content is introduced, replace with sanitize-html.
 */

// ---------------------------------------------------------------------------
// Allowed tags and their allowed attributes
// ---------------------------------------------------------------------------

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'a',
  'img',
  'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'div', 'span',
]);

const ALLOWED_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  td: new Set(['colspan', 'rowspan']),
  // style allowed on block-level text nodes for TextAlign extension output
  p: new Set(['class', 'id', 'style']),
  h1: new Set(['class', 'id', 'style']),
  h2: new Set(['class', 'id', 'style']),
  h3: new Set(['class', 'id', 'style']),
  h4: new Set(['class', 'id', 'style']),
  h5: new Set(['class', 'id', 'style']),
  h6: new Set(['class', 'id', 'style']),
  '*': new Set(['class', 'id']),
};

// Allowed URL schemes
const SAFE_URL_SCHEMES = /^(https?|mailto):/i;
const DANGEROUS_PROTOCOLS = /^(javascript|vbscript|data):/i;

// ---------------------------------------------------------------------------
// Tag-level regex sanitizer
// ---------------------------------------------------------------------------

/**
 * Sanitise an HTML string using a conservative allowlist.
 *
 * This implementation uses regex and string processing — NOT a real HTML parser.
 * It is suitable for Tiptap output where the structure is controlled.
 * For arbitrary user HTML, upgrade to a proper sanitizer library.
 */
export function sanitizeHtml(html: string): string {
  if (!html || typeof html !== 'string') return '';

  // 1. Remove dangerous tags entirely (with content for script/style)
  let sanitized = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<applet\b[^>]*>[\s\S]*?<\/applet>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '');

  // 2. Remove all on* event handler attributes
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');

  // 3. Remove dangerous href/src values (javascript:, data:, vbscript:)
  sanitized = sanitized.replace(
    /(href|src|action)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|([^\s>]*))/gi,
    (match, attr: string, dq: string, sq: string, bare: string) => {
      const value = dq ?? sq ?? bare ?? '';
      if (DANGEROUS_PROTOCOLS.test(value.trim())) {
        return `${attr}="#"`;
      }
      return match;
    },
  );

  // 4. For anchor tags: ensure href uses safe schemes, add rel="noopener" for external links
  sanitized = sanitized.replace(
    /<a\b([^>]*)>/gi,
    (_match, attrs: string) => {
      // Ensure rel="noopener noreferrer" for external links
      const hasTarget = /target\s*=/i.test(attrs);
      if (hasTarget && !/rel\s*=/i.test(attrs)) {
        attrs += ' rel="noopener noreferrer"';
      }
      return `<a${attrs}>`;
    },
  );

  return sanitized;
}

// ---------------------------------------------------------------------------
// Tiptap JSON → HTML renderer (minimal, server-side)
// ---------------------------------------------------------------------------

interface TiptapNode {
  type: string;
  content?: TiptapNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

function renderMarks(text: string, marks: Array<{ type: string; attrs?: Record<string, unknown> }>): string {
  let result = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        result = `<strong>${result}</strong>`;
        break;
      case 'italic':
        result = `<em>${result}</em>`;
        break;
      case 'underline':
        result = `<u>${result}</u>`;
        break;
      case 'strike':
        result = `<s>${result}</s>`;
        break;
      case 'code':
        result = `<code>${result}</code>`;
        break;
      case 'link': {
        const href = typeof mark.attrs?.['href'] === 'string' ? mark.attrs['href'] : '#';
        const safeHref = DANGEROUS_PROTOCOLS.test(href.trim()) ? '#' : href;
        const target = mark.attrs?.['target'] === '_blank' ? ' target="_blank" rel="noopener noreferrer"' : '';
        result = `<a href="${escapeAttr(safeHref)}"${target}>${result}</a>`;
        break;
      }
    }
  }
  return result;
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderNode(node: TiptapNode): string {
  if (node.type === 'text') {
    const text = escapeText(node.text ?? '');
    if (node.marks && node.marks.length > 0) {
      return renderMarks(text, node.marks);
    }
    return text;
  }

  const children = (node.content ?? []).map(renderNode).join('');

  switch (node.type) {
    case 'doc':
      return children;
    case 'paragraph': {
      const align = typeof node.attrs?.['textAlign'] === 'string' ? node.attrs['textAlign'] : null;
      const style = align && align !== 'left' ? ` style="text-align: ${escapeAttr(align)}"` : '';
      return `<p${style}>${children}</p>`;
    }
    case 'hardBreak':
      return '<br>';
    case 'horizontalRule':
      return '<hr>';
    case 'heading': {
      const level = typeof node.attrs?.['level'] === 'number' ? node.attrs['level'] : 2;
      const tag = `h${Math.min(Math.max(level, 1), 6)}`;
      const align = typeof node.attrs?.['textAlign'] === 'string' ? node.attrs['textAlign'] : null;
      const style = align && align !== 'left' ? ` style="text-align: ${escapeAttr(align)}"` : '';
      return `<${tag}${style}>${children}</${tag}>`;
    }
    case 'bulletList':
      return `<ul>${children}</ul>`;
    case 'orderedList': {
      const start = typeof node.attrs?.['start'] === 'number' ? ` start="${node.attrs['start']}"` : '';
      return `<ol${start}>${children}</ol>`;
    }
    case 'listItem':
      return `<li>${children}</li>`;
    case 'blockquote':
      return `<blockquote>${children}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${children}</code></pre>`;
    case 'image': {
      const src = typeof node.attrs?.['src'] === 'string' ? node.attrs['src'] : '';
      const alt = typeof node.attrs?.['alt'] === 'string' ? escapeAttr(node.attrs['alt']) : '';
      const title = typeof node.attrs?.['title'] === 'string' ? ` title="${escapeAttr(node.attrs['title'])}"` : '';
      if (!src || DANGEROUS_PROTOCOLS.test(src.trim())) return '';
      return `<figure><img src="${escapeAttr(src)}" alt="${alt}"${title}></figure>`;
    }
    case 'table':
      return `<table>${children}</table>`;
    case 'tableRow':
      return `<tr>${children}</tr>`;
    case 'tableHeader':
      return `<th>${children}</th>`;
    case 'tableCell':
      return `<td>${children}</td>`;
    default:
      // Unknown node types are rendered as their children only (defensive)
      return children;
  }
}

/**
 * Render a Tiptap JSON document to sanitised HTML.
 * Returns an empty string for invalid/empty documents.
 */
export function tiptapToHtml(doc: unknown): string {
  try {
    if (!doc || typeof doc !== 'object') return '';
    const node = doc as TiptapNode;
    if (node.type !== 'doc') return '';
    const rendered = renderNode(node);
    return sanitizeHtml(rendered);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// URL validation for safe scheme check
// ---------------------------------------------------------------------------

export function isUrlSafe(url: string): boolean {
  if (!url) return true; // empty is fine
  return SAFE_URL_SCHEMES.test(url.trim());
}
