import { listen } from '../src/http.mjs';

const CRLF = '\r\n';
const BOUNDARY = 'web-boundary';

function part(lines) {
  return lines.join(CRLF);
}

function packageOf(parts, extra = '') {
  return 'MIME-Version: 1.0' + CRLF
    + 'Content-Type: multipart/related; boundary="' + BOUNDARY + '"; start="<root>"; type="text/html"' + extra + CRLF
    + CRLF
    + parts.map(value => '--' + BOUNDARY + CRLF + value + CRLF).join('')
    + '--' + BOUNDARY + '--' + CRLF;
}

const ROOT = part([
  'Content-Type: text/html; charset=utf-8',
  'Content-ID: <root>',
  'Content-Location: https://exhibit.test/a/index.html',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><head><base href="../b/"></head><body>=E8=B5=84=E6=96=99'
    + '<img src="cid:logo"><iframe src="child.html"></iframe>'
    + '<img src="missing.png"></body></html>',
]);

const LOGO = part([
  'Content-Type: image/png',
  'Content-ID: <logo>',
  'Content-Location: https://exhibit.test/img/logo.png',
  'Content-Transfer-Encoding: base64',
  '',
  'aGVsbG8=',
]);

const CHILD = part([
  'Content-Type: text/html; charset=utf-8',
  'Content-Location: https://exhibit.test/b/child.html',
  '',
  '<p>child<img src="logo.png"></p>',
]);

const B_LOGO_FIRST = part([
  'Content-Type: image/png',
  'Content-Location: https://exhibit.test/b/logo.png',
  '',
  'first',
]);

const B_LOGO_SECOND = part([
  'Content-Type: image/png',
  'Content-Location: https://exhibit.test/b/logo.png',
  '',
  'second',
]);

// Root is deliberately not the first part: start="<root>" must win.
const NORMAL = [LOGO, ROOT, CHILD, B_LOGO_FIRST, B_LOGO_SECOND];

// The root sits inside a nested multipart/related container.
const NESTED_ROOT = part([
  'Content-Type: text/html; charset=gbk',
  'Content-ID: <nested-root>',
  'Content-Location: https://exhibit.test/n/frame.html',
  'Content-Transfer-Encoding: base64',
  '',
  'PHA+1tDOxDxpbWcgc3JjPSJuZXN0ZWQucG5nIj48L3A+',
]);

const NESTED = [
  LOGO,
  part([
    'Content-Type: multipart/related; boundary="nested-boundary"; start="<nested-root>"',
    'Content-ID: <container>',
    '',
    '--nested-boundary' + CRLF + NESTED_ROOT + CRLF
      + '--nested-boundary' + CRLF
      + part([
        'Content-Type: image/png',
        'Content-Location: https://exhibit.test/n/nested.png',
        '',
        'nested-bytes',
      ]) + CRLF
      + '--nested-boundary--' + CRLF,
  ]),
  CHILD,
  B_LOGO_FIRST,
  B_LOGO_SECOND,
];

// A page that references itself and its own child forms a cycle.
const CYCLE_ROOT = part([
  'Content-Type: text/html',
  'Content-ID: <root>',
  'Content-Location: https://exhibit.test/c/a.html',
  '',
  '<iframe src="b.html"></iframe><img src="cid:logo">',
]);

const CYCLE_CHILD = part([
  'Content-Type: text/html',
  'Content-Location: https://exhibit.test/c/b.html',
  '',
  '<iframe src="a.html"></iframe>',
]);

const CYCLES = [LOGO, CYCLE_ROOT, CYCLE_CHILD, B_LOGO_FIRST, B_LOGO_SECOND];

const CLEAN_ROOT = part([
  'Content-Type: text/html; charset=utf-8',
  'Content-ID: <root>',
  'Content-Location: https://exhibit.test/c/a/index.html',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><head><base href="../b/"></head><body>=E8=B5=84=E6=96=99'
    + '<img src="cid:logo"><iframe src="child.html"></iframe>'
    + '<img src="logo.png"></body></html>',
]);

const CLEAN_CHILD = part([
  'Content-Type: text/html; charset=utf-8',
  'Content-Location: https://exhibit.test/c/b/child.html',
  '',
  '<p>child<img src="logo.png"></p>',
]);

const CLEAN_LOGO_FIRST = part([
  'Content-Type: image/png',
  'Content-Location: https://exhibit.test/c/b/logo.png',
  '',
  'first',
]);

const CLEAN = [LOGO, CLEAN_ROOT, CLEAN_CHILD, CLEAN_LOGO_FIRST];

export function saved(kind = 'normal') {
  let result;
  switch (kind) {
    case 'nested':
      result = packageOf(NESTED);
      result = result.replace('start="<root>"', 'start="<container>"');
      break;
    case 'cycles':
      result = packageOf(CYCLES);
      break;
    case 'clean':
      result = packageOf(CLEAN);
      break;
    default:
      result = packageOf(NORMAL);
  }
  if (kind === 'truncated') result = result.slice(0, -30);
  return Buffer.from(result);
}

export async function startFixture() {
  return listen(async url => (url.pathname === '/saved.mhtml'
    ? { type: 'multipart/related', body: saved(url.searchParams.get('kind')) }
    : { status: 404, body: {} }));
}
