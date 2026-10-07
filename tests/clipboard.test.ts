import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { elementHtml, readableText } from '../src/clipboard';

function content(markup: string) {
  const { document } = parseHTML(`<body><div class="message-content">${markup}</div></body>`);
  return document.querySelector('.message-content')!;
}

test('plain text drops Markdown markers but keeps list, code and table structure', () => {
  const text = readableText(content(`
    <h2>实现思路</h2>
    <p>先完成 <strong>三栏布局</strong>，再参考 <a href="https://example.com/docs">文档</a>。</p>
    <ul><li>第一项</li><li>第二项<ul><li>子项</li></ul></li></ul>
    <ol><li>步骤一</li><li>步骤二</li></ol>
    <blockquote>引用的话</blockquote>
    <div class="code-wrap"><button class="code-copy">复制代码</button><pre><code>const branch = createBranch(answer);</code></pre></div>
    <table><thead><tr><th>协议</th><th>端点</th></tr></thead><tbody><tr><td>chat</td><td>/v1/chat/completions</td></tr></tbody></table>
  `));
  assert.match(text, /^实现思路$/m);
  assert.match(text, /先完成 三栏布局，再参考 文档（https:\/\/example.com\/docs）。/);
  assert.match(text, /^• 第一项$/m);
  assert.match(text, /^• 第二项$/m);
  assert.match(text, /^ {2}• 子项$/m, '嵌套列表需要缩进');
  assert.match(text, /^1\. 步骤一$/m);
  assert.match(text, /^2\. 步骤二$/m);
  assert.match(text, /^引用的话$/m);
  assert.match(text, /^const branch = createBranch\(answer\);$/m);
  assert.match(text, /^协议\t端点$/m, '表格按 tab 分隔');
  assert.match(text, /^chat\t\/v1\/chat\/completions$/m);
  assert.doesNotMatch(text, /复制代码/, '交互按钮不得进入剪贴板');
  assert.doesNotMatch(text, /[*#`]/, '不应残留 Markdown 标记');
});

test('rich text keeps the rendered markup without the interactive controls', () => {
  const html = elementHtml(content('<p>正文 <strong>加粗</strong></p><div class="code-wrap"><button class="code-copy">复制代码</button><pre><code>x</code></pre></div><span class="stream-cursor"></span>'));
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<pre><code>x<\/code><\/pre>/);
  assert.doesNotMatch(html, /复制代码/);
  assert.doesNotMatch(html, /stream-cursor/);
});
