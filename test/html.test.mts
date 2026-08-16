// HTML kernel tests: sanitizeHtmlBatch (ammonia), markdownToHtmlBatch
// (comrak), htmlToTextBatch (html2text), htmlExtractBatch (scraper).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import b from '@offthread/threadmill';

// ---------------------------------------------------------------- sanitizeHtml

test('sanitizeHtmlBatch defaults: strips <script> and onclick, keeps allowed tags', async () => {
  const [out] = await b.sanitizeHtmlBatch([
    '<b>bold</b> <script>alert(1)</script> <i onclick="evil()">it</i>',
  ]);
  assert.ok(out.includes('<b>bold</b>'));
  assert.ok(out.includes('<i>it</i>'));
  assert.ok(!out.includes('script'));
  assert.ok(!out.includes('alert'));
  assert.ok(!out.includes('onclick'));
});

test('sanitizeHtmlBatch defaults: keeps href, forces rel, drops javascript: URLs', async () => {
  const [ok, evil] = await b.sanitizeHtmlBatch([
    '<a href="https://example.com">x</a>',
    '<a href="javascript:alert(1)">y</a>',
  ]);
  assert.ok(ok.includes('href="https://example.com"'));
  assert.ok(ok.includes('rel="noopener noreferrer"'));
  assert.ok(!evil.includes('javascript:'));
  assert.ok(evil.includes('>y</a>')); // element survives, dangerous URL does not
});

test('sanitizeHtmlBatch custom allowedTags replaces the default whitelist', async () => {
  const [out] = await b.sanitizeHtmlBatch(
    ['<b>keep</b> <em>drop-tag-keep-text</em>'],
    { allowedTags: ['b'] },
  );
  assert.equal(out, '<b>keep</b> drop-tag-keep-text');
});

test('sanitizeHtmlBatch allowedAttrs: per-tag and "*" generic attributes', async () => {
  const [perTag] = await b.sanitizeHtmlBatch(
    ['<a href="https://x.io" title="t" data-x="1">go</a>'],
    { allowedTags: ['a'], allowedAttrs: { a: ['href'] }, urlSchemes: ['https'] },
  );
  assert.ok(perTag.includes('href="https://x.io"'));
  assert.ok(!perTag.includes('title='));
  assert.ok(!perTag.includes('data-x'));

  const [generic] = await b.sanitizeHtmlBatch(
    ['<b data-x="1" title="t">z</b>'],
    { allowedAttrs: { '*': ['data-x'] } },
  );
  assert.ok(generic.includes('data-x="1"'));
  assert.ok(!generic.includes('title=')); // generic list replaced ammonia's default
});

test('sanitizeHtmlBatch urlSchemes: http-only policy drops https links', async () => {
  const [out] = await b.sanitizeHtmlBatch(
    ['<a href="https://x.io">a</a><a href="http://x.io">b</a>'],
    { urlSchemes: ['http'] },
  );
  assert.ok(!out.includes('https://'));
  assert.ok(out.includes('href="http://x.io"'));
});

test('sanitizeHtmlBatch stripComments toggle', async () => {
  const html = 'a<!-- secret -->b';
  const [stripped] = await b.sanitizeHtmlBatch([html]);
  assert.equal(stripped, 'ab');
  const [kept] = await b.sanitizeHtmlBatch([html], { stripComments: false });
  assert.ok(kept.includes('<!-- secret -->'));
});

test('sanitizeHtmlBatch: allowing script/style or rel does not panic (ammonia footguns)', async () => {
  // script/style sit on ammonia's strip-with-content blacklist; allowing them
  // must lift that instead of panicking the rayon thread.
  const [style] = await b.sanitizeHtmlBatch(['<style>a{}</style>'], { allowedTags: ['style'] });
  assert.equal(style, '<style>a{}</style>');
  // user-controlled rel contradicts ammonia's forced link rel -> we disable the latter
  const [rel] = await b.sanitizeHtmlBatch(
    ['<a href="https://x.io" rel="me">x</a>'],
    { allowedTags: ['a'], allowedAttrs: { a: ['href', 'rel'] } },
  );
  assert.ok(rel.includes('rel="me"'));
});

test('sanitizeHtmlBatch preserves unicode text', async () => {
  const [out] = await b.sanitizeHtmlBatch(['<b>héllo 🚀</b>']);
  assert.equal(out, '<b>héllo 🚀</b>');
});

test('sanitizeHtmlBatch policy validation is sync with code InvalidArg', () => {
  for (const policy of [
    { allowedTags: ['b', ''] },
    { urlSchemes: [''] },
    { allowedAttrs: { '': ['x'] } },
    { allowedAttrs: { a: [''] } },
  ]) {
    assert.throws(
      () => b.sanitizeHtmlBatch(['<b>x</b>'], policy as any),
      (err: unknown) => {
        assert.equal((err as any).code, 'InvalidArg');
        assert.match((err as Error).message, /sanitizeHtml/);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------- markdownToHtml

test('markdownToHtmlBatch: headings and GFM table (gfm default on)', async () => {
  const [h, t] = await b.markdownToHtmlBatch([
    '# Hello',
    '| a | b |\n|---|---|\n| c | d |\n',
  ]);
  assert.equal(h, '<h1>Hello</h1>\n');
  assert.equal(
    t,
    '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n' +
      '<tbody>\n<tr>\n<td>c</td>\n<td>d</td>\n</tr>\n</tbody>\n</table>\n',
  );
});

test('markdownToHtmlBatch: strikethrough with gfm, off without', async () => {
  const [on] = await b.markdownToHtmlBatch(['~~gone~~']);
  assert.equal(on, '<p><del>gone</del></p>\n');
  const [off] = await b.markdownToHtmlBatch(['~~gone~~'], { gfm: false });
  assert.ok(!off.includes('<del>'));
});

test('markdownToHtmlBatch: tables toggle independent of gfm', async () => {
  const md = '| a |\n|---|\n| b |\n';
  const [off] = await b.markdownToHtmlBatch([md], { tables: false });
  assert.ok(!off.includes('<table>'));
  const [on] = await b.markdownToHtmlBatch([md], { gfm: false, tables: true });
  assert.ok(on.includes('<table>'));
});

test('markdownToHtmlBatch: raw HTML is escaped by default, passed through with unsafe', async () => {
  const md = 'x <span class="q">y</span>';
  const [safe] = await b.markdownToHtmlBatch([md]);
  assert.ok(safe.includes('&lt;span class=&quot;q&quot;&gt;'));
  assert.ok(!safe.includes('<span'));
  const [raw] = await b.markdownToHtmlBatch([md], { unsafe: true });
  assert.ok(raw.includes('<span class="q">y</span>'));
});

test('markdownToHtmlBatch: footnotes and smartPunct are opt-in', async () => {
  const fn = 'ref[^1]\n\n[^1]: the note\n';
  const [noFn] = await b.markdownToHtmlBatch([fn]);
  assert.ok(!noFn.includes('footnote'));
  const [withFn] = await b.markdownToHtmlBatch([fn], { footnotes: true });
  assert.ok(withFn.includes('footnote'));

  const [dumb] = await b.markdownToHtmlBatch(['"hi" -- there']);
  assert.ok(dumb.includes('&quot;hi&quot; -- there'));
  const [smart] = await b.markdownToHtmlBatch(['"hi" -- there'], { smartPunct: true });
  assert.ok(smart.includes('“hi”'));
  assert.ok(smart.includes('–'));
});

test('round-trip sanity: markdown (unsafe) -> sanitize strips the injected script', async () => {
  const [html] = await b.markdownToHtmlBatch(
    ['# Hi\n\n<script>alert(1)</script>\n\n*ok*'],
    { unsafe: true, gfm: false },
  );
  assert.ok(html.includes('<script>')); // unsafe really passed it through
  const [clean] = await b.sanitizeHtmlBatch([html]);
  assert.ok(!clean.includes('script'));
  assert.ok(clean.includes('<em>ok</em>'));
  assert.ok(clean.includes('Hi'));
});

// ---------------------------------------------------------------- htmlToText

test('htmlToTextBatch renders text content', async () => {
  const [out] = await b.htmlToTextBatch(['<p>Hello <b>world</b></p>']);
  assert.ok(out.includes('Hello'));
  assert.ok(out.includes('world'));
  assert.ok(!out.includes('<p>'));
});

test('htmlToTextBatch wraps at the requested width', async () => {
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const [out] = await b.htmlToTextBatch([`<p>${words}</p>`], { width: 20 });
  const lines = out.split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length > 5, 'narrow width must force wrapping');
  for (const line of lines) assert.ok(line.length <= 20, `line too long: ${line}`);
  // default width 80 wraps far less
  const [wide] = await b.htmlToTextBatch([`<p>${words}</p>`]);
  assert.ok(wide.split('\n').filter((l) => l.length > 0).length < lines.length);
});

test('htmlToTextBatch handles unicode and lists', async () => {
  const [out] = await b.htmlToTextBatch(['<ul><li>héllo</li><li>🚀 go</li></ul>']);
  assert.ok(out.includes('héllo'));
  assert.ok(out.includes('🚀 go'));
});

test('htmlToTextBatch width validation is sync with code InvalidArg', () => {
  for (const width of [0, 1001, -5]) {
    assert.throws(
      () => b.htmlToTextBatch(['<p>x</p>'], { width }),
      (err: unknown) => {
        assert.equal((err as any).code, 'InvalidArg');
        assert.match((err as Error).message, /width must be 1-1000/);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------- htmlExtract

const FIXTURE =
  '<html><body><ul><li class="x">One</li><li>Two</li></ul>' +
  '<a href="https://a.io" id="l">Go</a></body></html>';

test('htmlExtractBatch text: first match by default, all matches as JSON with all:true', async () => {
  const [first] = await b.htmlExtractBatch([FIXTURE], { selector: 'li', extract: 'text' });
  assert.equal(first, 'One');
  const [all] = await b.htmlExtractBatch([FIXTURE], { selector: 'li', extract: 'text', all: true });
  assert.deepEqual(JSON.parse(all), ['One', 'Two']);
});

test('htmlExtractBatch attr: pulls attributes, null for missing with all:true', async () => {
  const [href] = await b.htmlExtractBatch([FIXTURE], { selector: 'a', extract: { attr: 'href' } });
  assert.equal(href, 'https://a.io');
  const [classes] = await b.htmlExtractBatch([FIXTURE], {
    selector: 'li',
    extract: { attr: 'class' },
    all: true,
  });
  assert.deepEqual(JSON.parse(classes), ['x', null]);
});

test('htmlExtractBatch html: outer HTML of the match', async () => {
  const [out] = await b.htmlExtractBatch([FIXTURE], { selector: 'li.x', extract: 'html' });
  assert.equal(out, '<li class="x">One</li>');
});

test('htmlExtractBatch: no match -> empty string, or [] with all:true', async () => {
  const cfg = { selector: 'h1', extract: 'text' } as const;
  assert.deepEqual(await b.htmlExtractBatch([FIXTURE], cfg), ['']);
  const [empty] = await b.htmlExtractBatch([FIXTURE], { ...cfg, all: true });
  assert.deepEqual(JSON.parse(empty), []);
});

test('htmlExtractBatch accepts Buffer and string items alike', async () => {
  const got = await b.htmlExtractBatch(
    [Buffer.from(FIXTURE), FIXTURE, '<p>héllo 🚀</p>'],
    { selector: 'a, p', extract: 'text' },
  );
  assert.deepEqual(got, ['Go', 'Go', 'héllo 🚀']);
});

test('htmlExtractBatch: invalid selector throws sync InvalidArg naming the selector', () => {
  assert.throws(
    () => b.htmlExtractBatch([FIXTURE], { selector: 'li[', extract: 'text' }),
    (err: unknown) => {
      assert.equal((err as any).code, 'InvalidArg');
      assert.match((err as Error).message, /invalid selector 'li\['/);
      return true;
    },
  );
});

test('htmlExtractBatch: bad extract keyword / empty attr throw sync InvalidArg', () => {
  for (const extract of ['bogus', { attr: '' }]) {
    assert.throws(
      () => b.htmlExtractBatch([FIXTURE], { selector: 'a', extract: extract as any }),
      (err: unknown) => {
        assert.equal((err as any).code, 'InvalidArg');
        assert.match((err as Error).message, /htmlExtract/);
        return true;
      },
    );
  }
});

test('htmlExtractBatch: non-UTF-8 buffer rejects the batch naming the item', async () => {
  await assert.rejects(
    b.htmlExtractBatch([FIXTURE, Buffer.from([0xff, 0xfe, 0xfd])], {
      selector: 'a',
      extract: 'text',
    }),
    (err: unknown) => {
      assert.match((err as Error).message, /^item 1: htmlExtract: invalid utf-8/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- edges

test('empty batches and empty items resolve sensibly across all four kernels', async () => {
  assert.deepEqual(await b.sanitizeHtmlBatch([]), []);
  assert.deepEqual(await b.markdownToHtmlBatch([]), []);
  assert.deepEqual(await b.htmlToTextBatch([]), []);
  assert.deepEqual(await b.htmlExtractBatch([], { selector: 'a', extract: 'text' }), []);

  assert.deepEqual(await b.sanitizeHtmlBatch(['']), ['']);
  assert.deepEqual(await b.markdownToHtmlBatch(['']), ['']);
  const [txt] = await b.htmlToTextBatch(['']);
  assert.equal(txt.trim(), '');
  assert.deepEqual(await b.htmlExtractBatch([''], { selector: 'a', extract: 'text' }), ['']);
});
