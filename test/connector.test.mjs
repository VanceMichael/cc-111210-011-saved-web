import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, fetchPackage } from '../src/connector.mjs';
import { analyzePackage } from '../src/capture.mjs';
import {
  decodeBase64,
  decodeQuotedPrintable,
  decodeText,
  normalizeContentId,
  normalizeUrl,
  parseContentType,
  parseHeaders,
  parsePackage,
  splitHeaders,
} from '../src/mime.mjs';
import { startFixture, saved } from '../fixtures/source.mjs';

const CRLF = '\r\n';

function packageOf(parts, parameters = '; start="<root>"', boundary = 'B') {
  return Buffer.from(
    'MIME-Version: 1.0' + CRLF
    + 'Content-Type: multipart/related; boundary="' + boundary + '"' + parameters + CRLF
    + CRLF
    + parts.map(part => '--' + boundary + CRLF + part + CRLF).join('')
    + '--' + boundary + '--' + CRLF,
  );
}

function entity(headers, body) {
  return headers.join(CRLF) + CRLF + CRLF + body;
}

test('MIME折行头保留多值与正文偏移', () => {
  const parsed = splitHeaders(Buffer.from('X-A: one\r\n two\r\nX-A: three\r\n\r\nBODY'));
  assert.deepEqual(parsed.headers['x-a'], ['one two', 'three']);
  assert.equal(parsed.body.toString(), 'BODY');
  assert.throws(() => splitHeaders(Buffer.from('broken')), /未结束/);
});

test('头部缺失空行时仍保留可读正文', () => {
  const damaged = Buffer.from(
    'Content-Type: text/html' + CRLF
    + 'Content-ID: <root>' + CRLF
    + '<p>readable<img src="x.png"></p>' + CRLF,
  );
  const parsed = parseHeaders(damaged, 0, damaged.length);
  assert.equal(parsed.complete, false);
  assert.equal(parsed.headers['content-id'][0], '<root>');
  assert.match(damaged.subarray(parsed.bodyStart).toString(), /<p>readable/);

  const result = analyzePackage(packageOf([
    'Content-Type: text/html' + CRLF + 'Content-ID: <root>' + CRLF
      + '<p>readable<img src="x.png"></p>',
    entity(['Content-Type: image/png', 'Content-Location: https://exhibit.test/x.png'], 'XX'),
  ]));
  assert.equal(result.documents[0].text, '<p>readable<img src="x.png"></p>');
  assert.equal(result.references[0].status, 'missing');
  assert.ok(result.diagnostics.some(item => item.code === 'HEADER_INCOMPLETE'));
});

test('Content-Type 参数、Content-ID 与地址归一化', () => {
  const type = parseContentType('Text/HTML; Charset="UTF-8"; name*=UTF-8\'\'%E4%B8%AD.html');
  assert.equal(type.type, 'text/html');
  assert.equal(type.parameters.charset, 'UTF-8');
  assert.equal(type.parameters.name, '中.html');
  assert.equal(normalizeContentId('  cid:<Root%20One>  '), 'Root One');
  assert.equal(normalizeUrl('/a/../b/./c%7Ed.png#frag', 'https://h.test/x/y'), 'https://h.test/b/c~d.png');
  assert.notEqual(normalizeUrl('https://h.test/a/1.png'), normalizeUrl('https://h.test/a/2.png'));
});

test('传输编码与字符编码按声明解码', () => {
  assert.equal(decodeBase64(Buffer.from('aGVsbG8=\r\n')).bytes.toString(), 'hello');
  assert.equal(decodeQuotedPrintable(Buffer.from('=E8=B5=84=\r\n=E6=96=99')).bytes.toString(), '资料');
  const gbk = Buffer.from([0x3c, 0x70, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x2f, 0x70, 0x3e]);
  const decoded = decodeText(gbk, { 'content-type': ['text/html; charset=gbk'] }, { html: true });
  assert.equal(decoded.text, '<p>中文</p>');
  assert.equal(decoded.source, 'content-type');
  const meta = decodeText(Buffer.from('<meta charset="utf-8"><p>资料</p>', 'utf8'), {}, { html: true });
  assert.equal(meta.source, 'meta');
  assert.equal(meta.text, '<meta charset="utf-8"><p>资料</p>');
});

test('嵌套多部分共享编号并继承外层基址', () => {
  const nested = packageOf([
    entity(['Content-Type: multipart/related; boundary="C"; start="<inner>"', 'Content-ID: <container>'],
      '--C' + CRLF
      + entity([
        'Content-Type: text/html',
        'Content-ID: <inner>',
        'Content-Location: https://exhibit.test/proj/n/inner.html',
      ], '<img src="../img/x.png">') + CRLF
      + '--C--' + CRLF),
    entity(['Content-Type: image/png', 'Content-Location: https://exhibit.test/proj/img/x.png'], 'IMG'),
  ], '; start="<container>"');
  const parsed = parsePackage(nested);
  const flat = [];
  const walk = part => { flat.push(part); part.children.forEach(walk); };
  parsed.parts.forEach(walk);
  assert.deepEqual(flat.map(part => part.index), [0, 1, 2]);
  assert.equal(flat[1].parent.index, 0);

  const result = analyzePackage(nested);
  assert.equal(result.root.selection, 'start-container');
  assert.equal(result.root.part, 1);
  assert.equal(result.usable, true);
  assert.equal(result.references[0].status, 'resolved');
  assert.equal(result.references[0].targetIndex, 2);
  assert.equal(result.resources[0].previewBase64, Buffer.from('IMG').toString('base64'));
});

test('根文档按 start 选定而不是首个 HTML，同址异内容保持歧义', async () => {
  const source = await startFixture();
  try {
    const result = await inspect(source.url);
    assert.match(result.headers['content-type'][0], /start="<root>"/);
    const bytes = saved().toString();
    assert.ok(bytes.indexOf('image/png') < bytes.indexOf('Content-ID: <root>'));
    assert.equal(result.root.part, 1);
    assert.equal(result.root.selection, 'start');
    assert.equal(result.root.firstPart, false);
    assert.ok(result.diagnostics.some(item => item.code === 'ROOT_NOT_FIRST'));

    const cid = result.references.find(reference => reference.value === 'cid:logo');
    assert.equal(cid.status, 'resolved');
    assert.equal(cid.targetIndex, 0);
    assert.equal(cid.target.raw.offset, 264);
    assert.equal(cid.target.raw.length, 8);
    assert.equal(cid.target.decoded.digest, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');

    const ambiguous = result.ambiguous[0];
    assert.deepEqual(ambiguous.candidates, [3, 4]);
    assert.equal(ambiguous.sameContent, false);
    assert.ok(result.diagnostics.some(item => item.code === 'DUPLICATE_CONTENT_LOCATION'));

    const missing = result.missing[0];
    assert.equal(missing.value, 'missing.png');
    assert.equal(missing.normalizedUrl, 'https://exhibit.test/b/missing.png');
    assert.equal(missing.external, false);

    // The base element redirects relative lookups and the decoded text matches.
    assert.equal(result.documents[0].base, 'https://exhibit.test/b/');
    assert.match(result.documents[0].text, /资料/);
    assert.equal(result.documents[0].usable, false);
    assert.equal(result.usable, false);
  } finally {
    await source.close();
  }
});

test('截断包保留可读部分但不标记可用', async () => {
  const source = await startFixture();
  try {
    const result = await inspect(source.url, { kind: 'truncated' });
    assert.equal(result.package.truncated, true);
    assert.equal(result.package.complete, false);
    assert.equal(result.usable, false);
    assert.equal(result.root.part, 1);
    assert.ok(result.diagnostics.some(item => item.code === 'PACKAGE_TRUNCATED'));
    assert.ok(result.diagnostics.some(item => item.code === 'TRUNCATED_PART'));
    const last = result.parts.at(-1);
    assert.equal(last.truncated, true);
    assert.equal(last.raw.offset, result.package.bytes);
    assert.equal(last.raw.length, 0);
    assert.equal(result.documents.find(document => document.part === 1).problems.length, 2);
  } finally {
    await source.close();
  }
});

test('循环引用单独呈现且使相关文档不可用', async () => {
  const source = await startFixture();
  try {
    const result = await inspect(source.url, { kind: 'cycles' });
    assert.equal(result.cycles.length, 1);
    assert.deepEqual(result.cycles[0].parts, [1, 2]);
    assert.ok(result.diagnostics.some(item => item.code === 'REFERENCE_CYCLE'));
    assert.ok(result.documents.every(document => document.usable === false));
    assert.equal(result.usable, false);
  } finally {
    await source.close();
  }
});

test('干净包依赖闭合时才可用，未引用部分仍保留', async () => {
  const source = await startFixture();
  try {
    const result = await inspect(source.url, { kind: 'clean' });
    assert.equal(result.usable, true);
    assert.equal(result.documents.length, 2);
    assert.equal(result.counts.missing, 0);
    assert.equal(result.counts.ambiguous, 0);
    assert.equal(result.root.part, 1);
    assert.equal(result.references.length, 4);
    assert.equal(result.resources.length, 2);
    assert.equal(result.unreferencedParts.length, 0);
  } finally {
    await source.close();
  }
});

test('未引用、脚本与远端地址不联网补齐', () => {
  const result = analyzePackage(packageOf([
    entity([
      'Content-Type: text/html',
      'Content-ID: <root>',
      'Content-Location: https://exhibit.test/page.html',
    ], [
      '<script src="https://exhibit.test/evil.js">ignored()</script>',
      '<a href="https://exhibit.test/page">nav</a>',
      '<img src="javascript:alert(1)">',
      '<img src="https://exhibit.test/remote.png">',
      '<img src="local.png">',
    ].join('')),
    entity(['Content-Type: image/png', 'Content-Location: https://exhibit.test/local.png'], 'LOCAL'),
    entity(['Content-Type: image/png', 'Content-Location: https://exhibit.test/unused.png'], 'UNUSED'),
  ]));
  const statuses = Object.fromEntries(result.references.map(reference => [reference.value, reference.status]));
  assert.equal(statuses['local.png'], 'resolved');
  assert.equal(statuses['https://exhibit.test/remote.png'], 'missing');
  assert.equal(statuses['javascript:alert(1)'], 'blocked');
  assert.ok(!Object.hasOwn(statuses, 'https://exhibit.test/page'));
  assert.ok(result.references
    .filter(reference => reference.status === 'missing'
      && reference.value.startsWith('https://'))
    .every(reference => reference.external === true));
  assert.deepEqual(result.unreferencedParts.map(part => part.index), [2]);
  // The external script is reported missing, never fetched; the local part is
  // the only thing resolved.
  assert.equal(result.counts.resolved, 1);
});

test('来源读取受字节上限约束', async () => {
  const source = await startFixture();
  try {
    await assert.rejects(fetchPackage(source.url, { maxBytes: 100 }), /超过上限/);
    const fetched = await fetchPackage(source.url, { maxBytes: 1_000_000 });
    assert.equal(fetched.bytes.length, saved().length);
    assert.equal(fetched.digest.length, 64);
  } finally {
    await source.close();
  }
});
