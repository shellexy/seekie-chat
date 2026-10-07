// Copy helpers for message content.
//
// Plain text is derived from the rendered DOM rather than from the Markdown source, so lists keep
// their bullets, ordered items keep their numbers and table rows stay tab separated while every
// Markdown marker disappears. Rich text is the same rendered markup, minus the interactive bits.
const SKIPPED = new Set(['CODE-COPY', 'STREAM-CURSOR']);
function isSkipped(element: Element) {
  return SKIPPED.has(element.tagName) || element.classList.contains('code-copy') || element.classList.contains('stream-cursor');
}

function inlineText(node: Node): string {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const element = node as Element;
  if (isSkipped(element)) return '';
  if (element.tagName === 'BR') return '\n';
  if (element.tagName === 'A') {
    const text = Array.from(element.childNodes).map(inlineText).join('');
    const href = element.getAttribute('href') || '';
    return href && /^https?:\/\//.test(href) && href !== text.trim() ? `${text}（${href}）` : text;
  }
  return Array.from(element.childNodes).map(inlineText).join('');
}

function collectList(list: Element, out: string[], depth: number) {
  const ordered = list.tagName === 'OL';
  let index = 0;
  for (const item of Array.from(list.children)) {
    if (item.tagName !== 'LI') continue;
    index += 1;
    const nested = Array.from(item.children).filter(child => child.tagName === 'UL' || child.tagName === 'OL');
    const clone = item.cloneNode(true) as Element;
    for (const child of Array.from(clone.querySelectorAll('ul, ol'))) child.remove();
    const text = inlineText(clone).replace(/\s+/g, ' ').trim();
    if (text) out.push(`${'  '.repeat(depth)}${ordered ? `${index}.` : '•'} ${text}`);
    for (const child of nested) collectList(child, out, depth + 1);
  }
}

function collectTable(table: Element, out: string[]) {
  for (const row of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(row.querySelectorAll('th, td')).map(cell => inlineText(cell).replace(/\s+/g, ' ').trim());
    if (cells.some(Boolean)) out.push(cells.join('\t'));
  }
}

function collectBlocks(root: Element, out: string[], depth = 0) {
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) { const text = (node.textContent || '').trim(); if (text) out.push(text); continue; }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (isSkipped(element)) continue;
    const tag = element.tagName;
    if (tag === 'UL' || tag === 'OL') { collectList(element, out, depth); continue; }
    if (tag === 'TABLE') { collectTable(element, out); continue; }
    if (tag === 'PRE') { const code = (element.textContent || '').replace(/\n+$/, ''); if (code) out.push(code); continue; }
    // Wrappers (code block shell, loose div) are unwrapped; a real paragraph becomes one line.
    if (element.querySelector('p, ul, ol, pre, table, blockquote, h1, h2, h3, h4, h5, h6, hr')) { collectBlocks(element, out, depth); continue; }
    const text = inlineText(element).replace(/[ \t]+$/gm, '').trim();
    if (text) out.push(text);
  }
}

export function readableText(root: Element) {
  const lines: string[] = [];
  collectBlocks(root, lines);
  return lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function elementHtml(root: Element) {
  const copy = root.cloneNode(true) as Element;
  for (const node of Array.from(copy.querySelectorAll('.code-copy, .stream-cursor'))) node.remove();
  return copy.innerHTML.trim();
}

export function messageBodyNodes(messageId: string) {
  const article = document.getElementById(`message-${messageId}`);
  return article ? Array.from(article.querySelectorAll('.message-content')) : [];
}
/**
 * Every body block of a message as one element, so the copy helpers can walk an answer that continues
 * after reasoning or a tool call. A single block is returned as it is; several are wrapped in an
 * in-memory container (styling comes from the block classes, so the walk behaves identically).
 */
export function messageBodies(messageId: string) {
  const nodes = messageBodyNodes(messageId);
  if (!nodes.length) return null;
  if (nodes.length === 1) return nodes[0];
  const wrapper = document.createElement('div');
  for (const node of nodes) for (const child of Array.from(node.childNodes)) wrapper.append(child.cloneNode(true));
  return wrapper;
}
export function hasSelectionInside(messageId: string) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim() || !selection.rangeCount) return false;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const host = node.nodeType === 1 ? node as Element : node.parentElement;
  return !!host?.closest(`#message-${messageId}`);
}
export function selectedPlainText() { return window.getSelection()?.toString() || ''; }
export function selectedHtml() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return '';
  const holder = document.createElement('div');
  holder.appendChild(selection.getRangeAt(0).cloneContents());
  return holder.innerHTML;
}

export async function copyFlavors(plain: string, html?: string) {
  const clipboard = navigator.clipboard;
  if (html && typeof ClipboardItem !== 'undefined' && typeof clipboard?.write === 'function') {
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': new Blob([plain], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      return;
    } catch { /* Rich clipboard may be unavailable; plain text below still works. */ }
  }
  await clipboard.writeText(plain);
}
