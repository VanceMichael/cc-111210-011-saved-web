import {
  decodeText,
  decodeTransfer,
  contentTypeOf,
  hashBytes,
  normalizeContentId,
  normalizeUrl,
  parsePackage,
  urlScheme,
} from './mime.mjs';

const RESOURCE_ATTRIBUTES = {
  img: ['src', 'srcset'],
  input: ['src'],
  iframe: ['src'],
  frame: ['src'],
  embed: ['src'],
  object: ['data'],
  source: ['src', 'srcset'],
  audio: ['src'],
  video: ['src', 'poster'],
  track: ['src'],
  script: ['src'],
  link: ['href'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
};

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript']);
const NAVIGATION = new Set(['a', 'area']);
const LINK_RESOURCE_RELS = new Set([
  'stylesheet', 'icon', 'shortcut', 'apple-touch-icon', 'manifest', 'preload', 'modulepreload',
]);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–',
};

export function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);?/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function attributeMap(attributes) {
  const map = {};
  for (const attribute of attributes) if (!(attribute.name in map)) map[attribute.name] = attribute;
  return map;
}

function parseAttributes(text, start) {
  const attributes = [];
  let position = start;
  while (position < text.length) {
    while (position < text.length && /\s/.test(text[position])) position += 1;
    if (position >= text.length) break;
    if (text[position] === '>' || text[position] === '/') break;
    const nameStart = position;
    while (position < text.length && !/[\s=>/]/.test(text[position])) position += 1;
    if (position === nameStart) { position += 1; continue; }
    const name = text.slice(nameStart, position).toLowerCase();
    let value = '';
    let valueStart = position;
    let valueEnd = position;
    let after = position;
    while (after < text.length && /\s/.test(text[after])) after += 1;
    if (text[after] === '=') {
      position = after + 1;
      while (position < text.length && /\s/.test(text[position])) position += 1;
      const quote = text[position];
      if (quote === '"' || quote === "'") {
        position += 1;
        valueStart = position;
        while (position < text.length && text[position] !== quote) position += 1;
        valueEnd = position;
        value = text.slice(valueStart, valueEnd);
        if (position < text.length) position += 1;
      } else {
        valueStart = position;
        while (position < text.length && !/[\s>]/.test(text[position])) position += 1;
        valueEnd = position;
        value = text.slice(valueStart, valueEnd);
      }
    } else {
      position = after;
      valueStart = valueEnd = position;
    }
    attributes.push({ name, value, decoded: decodeEntities(value), start: valueStart, end: valueEnd });
  }
  return attributes;
}

/**
 * A deliberately small tag scanner. It does not build a DOM tree and it never
 * runs anything; it only finds the attributes that can name a package part.
 */
export function scanHtml(text) {
  const tags = [];
  const comments = [];
  let position = 0;
  while (position < text.length) {
    const open = text.indexOf('<', position);
    if (open < 0) break;
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      comments.push({ start: open, end: close < 0 ? text.length : close + 3 });
      position = close < 0 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + 9);
      position = close < 0 ? text.length : close + 3;
      continue;
    }
    if (text[open + 1] === '!' || text[open + 1] === '?') {
      const close = text.indexOf('>', open + 1);
      position = close < 0 ? text.length : close + 1;
      continue;
    }
    const match = /^<\/?([a-zA-Z][\w:-]*)/.exec(text.slice(open, open + 80));
    if (!match) { position = open + 1; continue; }
    const closing = text[open + 1] === '/';
    const name = match[1].toLowerCase();
    const afterName = open + match[0].length;
    if (closing) {
      const close = text.indexOf('>', afterName);
      position = close < 0 ? text.length : close + 1;
      tags.push({ name, closing: true, attributes: [], start: open, tagEnd: position });
      continue;
    }
    const attributes = parseAttributes(text, afterName);
    let close = afterName;
    while (close < text.length && text[close] !== '>') close += 1;
    const tag = {
      name,
      closing: false,
      attributes,
      start: open,
      tagEnd: close < text.length ? close + 1 : text.length,
      contentStart: null,
      contentEnd: null,
    };
    position = tag.tagEnd;
    if (RAW_TEXT.has(name)) {
      const endTag = text.toLowerCase().indexOf('</' + name, position);
      const contentEnd = endTag < 0 ? text.length : endTag;
      tag.contentStart = position;
      tag.contentEnd = contentEnd;
      position = contentEnd;
    }
    tags.push(tag);
  }
  return { tags, comments };
}

export function scanCss(text) {
  const masked = text.replace(/\/\*[\s\S]*?\*\//g, comment => ' '.repeat(comment.length));
  const references = [];
  const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
  let match;
  while ((match = urlPattern.exec(masked))) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (!value) continue;
    const offset = match[0].indexOf(value);
    references.push({ kind: 'css-url', value, start: match.index + offset, end: match.index + offset + value.length });
  }
  const importPattern = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
  while ((match = importPattern.exec(masked))) {
    const value = match[1] ?? match[2] ?? '';
    if (!value) continue;
    const offset = match[0].lastIndexOf(value);
    references.push({ kind: 'css-import', value, start: match.index + offset, end: match.index + offset + value.length });
  }
  return references;
}

function parseSrcset(value) {
  // Split on top-level commas first, then find the URL token so the recorded
  // offset stays exact even when candidates differ in length.
  const segments = [];
  let depth = 0;
  let last = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if ((character === ',' && depth === 0) || index === value.length) {
      segments.push({ start: last, end: index });
      last = index + 1;
    }
  }
  const candidates = [];
  for (const segment of segments) {
    const text = value.slice(segment.start, segment.end);
    const match = /\S+/.exec(text);
    if (!match) continue;
    candidates.push({ url: match[0], offset: segment.start + match.index });
  }
  return candidates;
}

function classifyPart(part) {
  const type = part.contentType.type;
  if (type.startsWith('multipart/')) return 'multipart';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'document';
  if (type === 'text/css') return 'stylesheet';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/')) return 'text';
  return 'binary';
}

function knownTransferEncoding(part) {
  return ['7bit', '8bit', 'binary', 'base64', 'quoted-printable', ''].includes(part.transferEncoding);
}

function issuesForPart(part) {
  const issues = [];
  if (part.truncated) issues.push('部分在包尾被截断，字节可能不完整');
  if (part.headerTruncated && !part.truncated) issues.push('部分头部在包尾被截断');
  if (!part.headerComplete) issues.push('部分头部未以空行结束');
  if (part.malformed) issues.push(part.malformed);
  if (!knownTransferEncoding(part)) issues.push(`不支持的传输编码 ${part.transferEncoding}`);
  return issues;
}

function decodePartBody(part) {
  if (part.decodedCache) return part.decodedCache;
  const decoded = decodeTransfer(part.rawBody, part.transferEncoding);
  part.decodedCache = decoded;
  return decoded;
}

function traceOf(part, withDecoded = true) {
  const trace = {
    index: part.index,
    contentType: part.contentType.type || 'application/octet-stream',
    contentId: part.contentId,
    contentLocation: part.contentLocation,
    raw: { offset: part.rawOffset, length: part.rawLength, digest: part.rawDigest },
    truncated: part.truncated,
  };
  if (withDecoded && ['base64', 'quoted-printable'].includes(part.transferEncoding)) {
    const decoded = decodePartBody(part);
    trace.decoded = { encoding: decoded.encoding, length: decoded.bytes.length, digest: hashBytes(decoded.bytes) };
  }
  return trace;
}

function previewBytes(bytes, limit, mime) {
  if (limit <= 0) return null;
  if (/^(image|audio|video|font)\//.test(mime) || /^application\/(octet-stream|pdf|zip)/.test(mime)) {
    return bytes.subarray(0, limit).toString('base64');
  }
  return null;
}

function resolveReference(value, base) {
  const raw = value.trim();
  if (!raw) return { status: 'local', reason: '空引用' };
  if (raw.startsWith('#')) return { status: 'local', reason: '仅指向包内片段' };
  if (/^data:/i.test(raw)) {
    const comma = raw.indexOf(',');
    const meta = comma >= 0 ? raw.slice(5, comma) : raw.slice(5);
    const base64 = /;base64$/i.test(meta);
    return {
      status: 'inline',
      mime: meta.split(';')[0] || null,
      inlineBytes: comma < 0 ? 0 : (base64 ? Math.floor((raw.length - comma - 1) * 3 / 4) : raw.length - comma - 1),
    };
  }
  if (/^(javascript|vbscript):/i.test(raw)) return { status: 'blocked', reason: '不执行脚本或伪协议' };
  if (/^cid:/i.test(raw)) {
    return { status: 'lookup', scheme: 'cid', key: normalizeContentId(raw), normalized: null };
  }
  const scheme = urlScheme(raw);
  if (scheme && !['http', 'https', 'file'].includes(scheme)) {
    return { status: 'blocked', reason: `不支持的地址协议 ${scheme}` };
  }
  const normalized = normalizeUrl(raw, base);
  if (!normalized) return { status: 'missing', reason: '地址无法归一化', normalized: null };
  return { status: 'lookup', scheme: scheme ?? 'relative', key: null, normalized };
}

/** Pick the root exactly as multipart/related says: start names a Content-ID. */
function selectRoot(parsed) {
  const all = [];
  const visit = part => {
    all.push(part);
    for (const child of part.children) visit(child);
  };
  for (const part of parsed.parts) visit(part);
  const byContentId = new Map();
  for (const part of all) {
    if (!part.contentId) continue;
    const list = byContentId.get(part.contentId) ?? [];
    list.push(part);
    byContentId.set(part.contentId, list);
  }
  const startId = normalizeContentId(parsed.start);
  if (startId) {
    const matches = byContentId.get(startId) ?? [];
    if (matches.length > 1) {
      return { root: matches[0], selection: 'start-ambiguous', startId, matches };
    }
    if (matches.length === 1) {
      const match = matches[0];
      if (match.kind !== 'multipart') {
        return { root: match, selection: 'start', startId, matches };
      }
      // Some packages point start at a multipart container. Resolve inside it
      // rather than treating the container as a displayable document.
      const descendants = [];
      const walk = candidate => {
        for (const child of candidate.children) {
          descendants.push(child);
          walk(child);
        }
      };
      walk(match);
      const byType = parsed.type
        ? descendants.filter(child => child.contentType.type === parsed.type.toLowerCase())
        : [];
      const documentChildren = descendants.filter(child => child.kind === 'document');
      const chosen = byType[0] ?? documentChildren[0] ?? descendants[0] ?? null;
      return {
        root: chosen,
        selection: chosen ? 'start-container' : 'start-missing',
        startId,
        matches,
        container: match.index,
      };
    }
    return { root: null, selection: 'start-missing', startId, matches };
  }
  const fallback = pickFallback(all, parsed);
  return fallback;
}

function pickFallback(all, parsed) {
  if (parsed.type) {
    const matches = all.filter(part => part.contentType.type === parsed.type.toLowerCase());
    if (matches.length) {
      return {
        root: matches[0],
        selection: matches.length > 1 ? 'type-ambiguous' : 'type',
        startId: null,
        matches,
      };
    }
  }
  const html = all.filter(part => part.kind === 'document');
  if (html.length) {
    return {
      root: html[0],
      selection: html.length > 1 ? 'first-html-ambiguous' : 'first-html',
      startId: null,
      matches: html,
    };
  }
  return { root: all[0] ?? null, selection: 'first-part', startId: null, matches: [] };
}

function collectPartRefs(part, text, documentBase) {
  const references = [];
  const add = (kind, value, start, extra = {}) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    references.push({
      id: `${part.index}:${references.length}`,
      sourcePart: part.index,
      kind,
      value: trimmed,
      start,
      end: start + value.length,
      ...extra,
      resolution: resolveReference(trimmed, documentBase),
    });
  };
  if (part.kind === 'document') {
    const { tags } = scanHtml(text);
    const baseTag = tags.find(tag => tag.name === 'base' && !tag.closing && attributeMap(tag.attributes).href);
    const baseHref = baseTag ? attributeMap(baseTag.attributes).href.decoded : null;
    if (baseHref) documentBase = normalizeUrl(baseHref, documentBase) ?? documentBase;
    for (const tag of tags) {
      if (tag.closing || tag.name === 'base') continue;
      const attributes = attributeMap(tag.attributes);
      if (NAVIGATION.has(tag.name)) continue;
      if (tag.name === 'link') {
        const rel = (attributes.rel?.decoded ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!rel.some(value => LINK_RESOURCE_RELS.has(value))) continue;
      }
      for (const name of RESOURCE_ATTRIBUTES[tag.name] ?? []) {
        const attribute = attributes[name];
        if (!attribute) continue;
        if (name === 'srcset') {
          for (const candidate of parseSrcset(attribute.decoded)) {
            add('srcset', candidate.url, attribute.start + candidate.offset, { tag: tag.name, attribute: name });
          }
          continue;
        }
        add('resource', attribute.decoded, attribute.start, { tag: tag.name, attribute: name });
      }
      if (tag.name === 'style' && tag.contentStart !== null) {
        const cssText = text.slice(tag.contentStart, tag.contentEnd);
        for (const cssRef of scanCss(cssText)) {
          add(cssRef.kind, cssRef.value, tag.contentStart + cssRef.start, { tag: tag.name, attribute: 'style-content' });
        }
      }
      if (attributes.style) {
        for (const cssRef of scanCss(attributes.style.decoded)) {
          add(cssRef.kind, cssRef.value, attributes.style.start + cssRef.start, { tag: tag.name, attribute: 'style' });
        }
      }
    }
  } else if (part.kind === 'stylesheet') {
    for (const cssRef of scanCss(text)) add(cssRef.kind, cssRef.value, cssRef.start);
  }
  return { references, documentBase };
}

function documentTitle(text) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text);
  return match ? decodeEntities(match[1]).trim().slice(0, 200) : null;
}

function stronglyConnected(edges) {
  let index = 0;
  const indexes = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = node => {
    indexes.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!indexes.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indexes.get(next)));
      }
    }
    if (low.get(node) === indexes.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  };
  for (const node of edges.keys()) if (!indexes.has(node)) visit(node);
  return components;
}

function flatten(parsed) {
  const all = [];
  const visit = part => {
    all.push(part);
    for (const child of part.children) visit(child);
  };
  for (const part of parsed.parts) visit(part);
  return all;
}

export function analyzePackage(bytes, options = {}) {
  const parsed = parsePackage(bytes, {
    maxParts: options.maxParts,
    maxDepth: options.maxDepth,
    maxHeaderBytes: options.maxHeaderBytes,
  });
  const packageBase = options.packageUrl
    ? normalizeUrl(options.packageUrl)
    : 'http://mhtml.invalid/package.mhtml';
  const maxDocumentChars = options.maxDocumentChars ?? 200_000;
  const maxPreviewBytes = options.maxPreviewBytes ?? 64;
  const diagnostics = [];

  const parts = flatten(parsed);
  const processed = new Set();
  const assign = (part, inherited) => {
    if (processed.has(part)) return;
    processed.add(part);
    part.locationUrl = part.contentLocation ? normalizeUrl(part.contentLocation, inherited) : null;
    part.contentBaseUrl = part.contentBase ? normalizeUrl(part.contentBase, inherited) : null;
    part.base = part.contentBaseUrl ?? part.locationUrl ?? inherited;
    part.kind = classifyPart(part);
    for (const child of part.children) assign(child, part.base);
  };
  for (const part of parsed.parts) assign(part, packageBase);

  if (parsed.truncated) {
    diagnostics.push({
      code: 'PACKAGE_TRUNCATED',
      severity: 'error',
      message: '包体不完整：结束边界或末段被截断，已保留可读部分',
      offset: bytes.length,
    });
  }
  const packageWarnings = new Set();
  for (const message of parsed.warnings) {
    if (packageWarnings.has(message)) continue;
    packageWarnings.add(message);
    const boundaryIssue = /边界|截断/.test(message);
    const topHeaderIssue = parsed.headerErrors.includes(message);
    diagnostics.push({
      code: boundaryIssue ? 'TAIL_BOUNDARY_MISSING' : (topHeaderIssue ? 'PACKAGE_HEADER_INVALID' : 'PACKAGE_WARNING'),
      severity: boundaryIssue || topHeaderIssue ? 'error' : 'warning',
      message,
      offset: bytes.length,
    });
  }
  for (const part of parts) {
    if (!part.headerComplete) {
      diagnostics.push({
        code: 'HEADER_INCOMPLETE', severity: 'warning', part: part.index,
        message: `部分 ${part.index} 的头部未完整结束，正文按能从字节中读出的内容保留`,
      });
    }
    if (part.headerTruncated && !part.truncated) {
      diagnostics.push({
        code: 'HEADER_TRUNCATED', severity: 'warning', part: part.index,
        message: `部分 ${part.index} 的头部在包尾被截断`,
      });
    }
    if (part.truncated) {
      diagnostics.push({
        code: 'TRUNCATED_PART', severity: 'warning', part: part.index,
        message: `部分 ${part.index} 在包尾截断`,
      });
    }
    if (part.malformed) {
      diagnostics.push({
        code: 'NESTED_BOUNDARY_MISSING', severity: 'error', part: part.index,
        message: `部分 ${part.index} ${part.malformed}`,
      });
    }
  }

  const byIndex = new Map(parts.map(part => [part.index, part]));
  const urlIndex = new Map();
  const cidIndex = new Map();
  for (const part of parts) {
    for (const value of new Set([part.locationUrl, part.contentBaseUrl])) {
      if (!value) continue;
      const list = urlIndex.get(value) ?? [];
      if (!list.includes(part)) list.push(part);
      urlIndex.set(value, list);
    }
    if (part.contentId) {
      const list = cidIndex.get(part.contentId) ?? [];
      list.push(part);
      cidIndex.set(part.contentId, list);
    }
  }
  for (const [url, list] of urlIndex) {
    if (list.length < 2) continue;
    const digests = new Set(list.map(part => part.rawDigest));
    diagnostics.push({
      code: 'DUPLICATE_CONTENT_LOCATION', severity: 'warning', url,
      parts: list.map(part => part.index),
      sameContent: digests.size === 1,
      message: `地址 ${url} 对应 ${list.length} 个${digests.size > 1 ? '内容不同的' : ''}部分，按该地址查找会产生歧义`,
    });
  }
  for (const [contentId, list] of cidIndex) {
    if (list.length < 2) continue;
    diagnostics.push({
      code: 'DUPLICATE_CONTENT_ID', severity: 'warning', contentId,
      parts: list.map(part => part.index),
      message: `Content-ID <${contentId}> 重复，引用会产生歧义`,
    });
  }

  const selection = selectRoot(parsed);
  const root = selection.root;
  if (selection.selection === 'start-missing') {
    diagnostics.push({
      code: 'ROOT_START_UNRESOLVED', severity: 'error',
      message: parsed.start
        ? `start="${parsed.start}" 在包内找不到对应 Content-ID`
        : 'multipart/related 缺少 start 参数',
    });
  } else if (selection.selection === 'start-ambiguous') {
    diagnostics.push({
      code: 'ROOT_START_AMBIGUOUS', severity: 'error',
      message: `start="${parsed.start}" 对应多个部分，无法唯一确定根文档`,
      parts: selection.matches.map(part => part.index),
    });
  } else if (selection.selection === 'start-container') {
    diagnostics.push({
      code: 'ROOT_START_CONTAINER', severity: 'warning', part: root?.index,
      container: selection.container,
      message: `start="${parsed.start}" 指向嵌套多部分容器 ${selection.container + 1}，已在其子部分中选择根文档`,
    });
  } else if (!selection.selection.startsWith('start')) {
    diagnostics.push({
      code: 'ROOT_START_MISSING', severity: 'warning',
      message: parsed.start
        ? `start="${parsed.start}" 未命中，按 Content-Type 参数或首个 HTML 选择根文档`
        : '包内没有 start 参数，按 Content-Type 参数或首个 HTML 选择根文档',
    });
  }
  if (root && root.index > 0) {
    diagnostics.push({
      code: 'ROOT_NOT_FIRST', severity: 'info', part: root.index,
      container: selection.container ?? null,
      message: `根文档${parsed.start ? `由 start=<${normalizeContentId(parsed.start) ?? parsed.start}> 指定` : '按回退规则选定'}，位于第 ${root.index + 1} 部分，不是包的首个部分`,
    });
  }
  if (!root) diagnostics.push({ code: 'ROOT_MISSING', severity: 'error', message: '包内没有可用根文档' });

  // Text bodies are decoded once; malformed transfer encodings keep raw bytes.
  const texts = new Map();
  const parseResults = new Map();
  for (const part of parts) {
    if (part.kind !== 'document' && part.kind !== 'stylesheet') continue;
    const decoded = decodePartBody(part);
    const textInfo = decodeText(decoded.bytes, part.headers, { html: part.kind === 'document' });
    const meta = /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(
      decoded.bytes.subarray(0, 4096).toString('latin1'),
    );
    const metaCharset = meta ? meta[1] : null;
    const declared = contentTypeOf(part.headers).parameters.charset ?? null;
    if (declared && metaCharset && declared.toLowerCase() !== metaCharset.toLowerCase()) {
      diagnostics.push({
        code: 'CHARSET_CONFLICT', severity: 'warning', part: part.index,
        message: `部分 ${part.index} 头部声明 ${declared}，正文 meta 声明 ${metaCharset}，按 ${textInfo.used} 读取`,
        declared, metaCharset, used: textInfo.used,
      });
    }
    if (!knownTransferEncoding(part)) {
      diagnostics.push({
        code: 'TRANSFER_ENCODING_UNSUPPORTED', severity: 'warning', part: part.index,
        message: `部分 ${part.index} 使用了不支持的传输编码 ${part.transferEncoding}`,
      });
    }
    texts.set(part.index, textInfo);
    parseResults.set(part.index, collectPartRefs(part, textInfo.text, part.base));
  }

  // Resolve references strictly inside the package. Address normalisation is
  // a lookup key only; every candidate part remains attached to its reference.
  const allReferences = [];
  for (const result of parseResults.values()) {
    for (const reference of result.references) {
      const resolution = reference.resolution;
      const resolved = {
        ...reference,
        base: result.documentBase,
        normalizedUrl: resolution.normalized ?? null,
        status: resolution.status,
        via: null,
        target: null,
        targetIndex: null,
        candidates: [],
      };
      if (resolution.status === 'lookup') {
        let matches;
        if (resolution.scheme === 'cid') {
          matches = cidIndex.get(resolution.key) ?? [];
          resolved.via = 'content-id';
          resolved.contentId = resolution.key;
          resolved.lookupKey = `<${resolution.key}>`;
        } else {
          matches = urlIndex.get(resolution.normalized) ?? [];
          resolved.via = 'content-location';
          resolved.lookupKey = resolution.normalized;
        }
        resolved.candidates = matches.map(match => traceOf(match, false));
        if (matches.length === 1) {
          resolved.status = 'resolved';
          resolved.target = traceOf(matches[0], true);
          resolved.targetIndex = matches[0].index;
          resolved.targetContentType = matches[0].contentType.type;
          resolved.targetKind = matches[0].kind;
        } else if (matches.length === 0) {
          resolved.status = 'missing';
          resolved.missingReason = resolution.scheme === 'cid'
            ? '包内没有该 Content-ID'
            : '包内没有该地址对应的部分';
          resolved.external = /^https?:/i.test(reference.value);
        } else {
          resolved.status = 'ambiguous';
          const digests = new Set(matches.map(match => match.rawDigest));
          resolved.ambiguity = {
            url: resolution.normalized ?? `<${resolution.key}>`,
            candidates: matches.map(match => match.index),
            sameContent: digests.size === 1,
            reason: digests.size > 1 ? '同一地址对应不同内容' : '同一地址对应多个部分',
          };
        }
      } else if (resolution.status === 'blocked') {
        resolved.blockedReason = resolution.reason;
      } else if (resolution.status === 'inline') {
        resolved.inline = { mime: resolution.mime, approximateBytes: resolution.inlineBytes };
      } else if (resolution.status === 'local') {
        resolved.localReason = resolution.reason;
      }
      allReferences.push(resolved);
    }
  }

  const refsByPart = new Map();
  const anyCandidates = new Map();
  for (const reference of allReferences) {
    const list = refsByPart.get(reference.sourcePart) ?? [];
    list.push(reference);
    refsByPart.set(reference.sourcePart, list);
    for (const candidate of reference.candidates) {
      const refs = anyCandidates.get(candidate.index) ?? [];
      refs.push(reference.id);
      anyCandidates.set(candidate.index, refs);
    }
  }

  const edges = new Map(parts.map(part => [part.index, new Set()]));
  for (const reference of allReferences) {
    if (reference.status === 'resolved') edges.get(reference.sourcePart)?.add(reference.targetIndex);
  }
  const components = stronglyConnected(edges);
  const cyclic = new Set();
  const cycles = [];
  for (const component of components) {
    const selfLoop = component.length === 1 && edges.get(component[0])?.has(component[0]);
    if (component.length < 2 && !selfLoop) continue;
    for (const member of component) cyclic.add(member);
    cycles.push({
      parts: [...component].sort((a, b) => a - b),
      references: allReferences
        .filter(reference => reference.status === 'resolved'
          && component.includes(reference.sourcePart)
          && component.includes(reference.targetIndex))
        .map(reference => ({ from: reference.sourcePart, to: reference.targetIndex, value: reference.value })),
    });
    diagnostics.push({
      code: 'REFERENCE_CYCLE', severity: 'error',
      parts: [...component].sort((a, b) => a - b),
      message: `检测到循环引用：部分 ${[...component].sort((a, b) => a - b).join('、')}`,
    });
  }

  for (const reference of allReferences) {
    if (reference.status === 'missing') {
      diagnostics.push({
        code: 'REFERENCE_MISSING', severity: 'error', part: reference.sourcePart, reference: reference.id,
        message: `部分 ${reference.sourcePart} 引用的 ${reference.value} 在包内缺失${reference.external ? '（外部地址，未联网获取）' : ''}`,
      });
    } else if (reference.status === 'ambiguous') {
      diagnostics.push({
        code: 'REFERENCE_AMBIGUOUS', severity: 'error', part: reference.sourcePart, reference: reference.id,
        message: `部分 ${reference.sourcePart} 引用的 ${reference.value} 对应多个部分（${reference.ambiguity.candidates.join('、')}），${reference.ambiguity.reason}`,
      });
    } else if (reference.status === 'blocked') {
      diagnostics.push({
        code: 'REFERENCE_BLOCKED', severity: 'warning', part: reference.sourcePart, reference: reference.id,
        message: `部分 ${reference.sourcePart} 的 ${reference.value} 未执行：${reference.blockedReason}`,
      });
    }
  }

  const closureOf = start => {
    const closure = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift();
      for (const next of edges.get(current) ?? []) {
        if (!closure.has(next)) { closure.add(next); queue.push(next); }
      }
    }
    return [...closure].sort((a, b) => a - b);
  };

  const documents = [];
  for (const part of parts) {
    if (part.kind !== 'document') continue;
    const textInfo = texts.get(part.index);
    const result = parseResults.get(part.index);
    const ownRefs = refsByPart.get(part.index) ?? [];
    const closureParts = closureOf(part.index);
    const problems = [];
    const warnings = [];
    if (part.truncated) problems.push('正文部分在包尾被截断');
    if (part.malformed) problems.push(part.malformed);
    for (const member of closureParts) {
      const memberPart = byIndex.get(member);
      if (member !== part.index && memberPart?.truncated) problems.push(`依赖部分 ${member} 被截断`);
      if (member !== part.index && memberPart?.malformed) problems.push(`依赖部分 ${member} 结构损坏`);
      for (const reference of refsByPart.get(member) ?? []) {
        if (reference.status === 'missing') problems.push(`缺失引用 ${reference.id}（${reference.value}）`);
        if (reference.status === 'ambiguous') problems.push(`歧义引用 ${reference.id}（${reference.value}）`);
        if (reference.status === 'blocked') warnings.push(`未执行的引用 ${reference.id}（${reference.value}）`);
      }
    }
    const closureCycles = closureParts.filter(member => cyclic.has(member));
    if (closureCycles.length) problems.push(`依赖图包含循环引用：${closureCycles.join('、')}`);
    if (textInfo?.replacements) warnings.push(`字符解码出现 ${textInfo.replacements} 个替换字符`);
    if (!knownTransferEncoding(part)) warnings.push(`不支持的传输编码 ${part.transferEncoding}`);
    const text = textInfo?.text ?? '';
    const clipped = text.length > maxDocumentChars;
    documents.push({
      part: part.index,
      title: documentTitle(text),
      usable: problems.length === 0,
      problems,
      warnings,
      selection: part === root ? selection.selection : 'reference',
      contentType: part.contentType.type,
      contentLocation: part.contentLocation,
      base: result?.documentBase ?? part.base,
      encoding: textInfo ? {
        declared: textInfo.declared,
        used: textInfo.used,
        source: textInfo.source,
        bom: textInfo.bom,
        replacements: textInfo.replacements,
        warnings: textInfo.warnings,
      } : null,
      text: clipped ? text.slice(0, maxDocumentChars) : text,
      textTruncated: clipped,
      textLength: text.length,
      textDigest: hashBytes(Buffer.from(text, 'utf8')),
      references: ownRefs,
      closureParts,
      missing: closureParts.flatMap(member => (refsByPart.get(member) ?? [])
        .filter(reference => reference.status === 'missing')
        .map(reference => ({ reference: reference.id, part: member, value: reference.value }))),
      ambiguous: closureParts.flatMap(member => (refsByPart.get(member) ?? [])
        .filter(reference => reference.status === 'ambiguous')
        .map(reference => ({ reference: reference.id, part: member, value: reference.value, ...reference.ambiguity }))),
      cycles: cycles.filter(cycle => cycle.parts.some(member => closureParts.includes(member))),
    });
  }

  const resources = [];
  const resolvedByTarget = new Map();
  const candidatesByTarget = new Map();
  for (const reference of allReferences) {
    if (reference.status === 'resolved') {
      const list = resolvedByTarget.get(reference.targetIndex) ?? [];
      list.push(reference);
      resolvedByTarget.set(reference.targetIndex, list);
    }
    for (const candidate of reference.candidates) {
      const list = candidatesByTarget.get(candidate.index) ?? [];
      list.push(reference);
      candidatesByTarget.set(candidate.index, list);
    }
  }
  for (const part of parts) {
    if (part.kind === 'document' || part.kind === 'multipart') continue;
    const incoming = resolvedByTarget.get(part.index) ?? [];
    const candidateRefs = candidatesByTarget.get(part.index) ?? [];
    if (!incoming.length && !candidateRefs.length) continue;
    const decoded = ['base64', 'quoted-printable'].includes(part.transferEncoding) ? decodePartBody(part) : null;
    const mime = part.contentType.type || 'application/octet-stream';
    const body = decoded?.bytes ?? part.rawBody;
    resources.push({
      part: part.index,
      contentType: mime,
      kind: part.kind,
      contentId: part.contentId,
      contentLocation: part.contentLocation,
      normalizedLocation: part.locationUrl,
      raw: { offset: part.rawOffset, length: part.rawLength, digest: part.rawDigest },
      decoded: decoded ? {
        encoding: decoded.encoding,
        length: decoded.bytes.length,
        digest: hashBytes(decoded.bytes),
        invalid: decoded.invalid,
      } : null,
      previewBase64: previewBytes(body, maxPreviewBytes, mime),
      truncated: part.truncated,
      referencedBy: incoming.map(reference => ({
        part: reference.sourcePart, reference: reference.id, via: reference.via, value: reference.value,
      })),
      candidateFor: candidateRefs.map(reference => ({
        part: reference.sourcePart, reference: reference.id, value: reference.value,
      })),
    });
  }

  const unreferencedParts = parts
    .filter(part => part.kind !== 'multipart' && part !== root && !(anyCandidates.get(part.index)?.length))
    .map(part => traceOf(part, false));
  for (const part of unreferencedParts) {
    diagnostics.push({
      code: 'UNREFERENCED_PART', severity: 'info', part: part.index,
      message: `部分 ${part.index}（${part.contentType}）未被任何引用指向，已保留在清单中`,
    });
  }

  const rootDocument = root ? documents.find(document => document.part === root.index) ?? null : null;
  if (root && !rootDocument) {
    diagnostics.push({
      code: 'ROOT_NOT_DOCUMENT', severity: 'error', part: root.index,
      message: `根部分 ${root.index} 的 Content-Type 为 ${root.contentType.type || '未声明'}，不是可展示的 HTML 文档`,
    });
  }

  const rootProblems = [];
  if (!root) rootProblems.push('未找到根文档');
  if (root && selection.selection === 'start-missing') rootProblems.push('start 指向的 Content-ID 不存在');
  if (root && selection.selection === 'start-ambiguous') rootProblems.push('start 指向多个部分');
  if (root && ['type-ambiguous', 'first-html-ambiguous'].includes(selection.selection)) {
    rootProblems.push('根文档并非唯一：包内存在多个同类型候选部分');
  }
  if (root && !rootDocument) rootProblems.push('根部分不是可展示的 HTML 文档');
  if (rootDocument) rootProblems.push(...rootDocument.problems);
  const usable = Boolean(rootDocument && rootDocument.usable && rootProblems.length === 0);

  const byKind = {};
  const byType = {};
  for (const part of parts) {
    byKind[part.kind] = (byKind[part.kind] ?? 0) + 1;
    const type = part.contentType.type || 'application/octet-stream';
    byType[type] = (byType[type] ?? 0) + 1;
  }

  const referenceCounts = allReferences.reduce((counts, reference) => {
    counts[reference.status] = (counts[reference.status] ?? 0) + 1;
    return counts;
  }, {});

  return {
    package: {
      bytes: bytes.length,
      digest: parsed.digest,
      contentType: parsed.contentType.type,
      boundary: parsed.boundary,
      start: parsed.start,
      startId: selection.startId,
      type: parsed.type,
      headerErrors: parsed.headerErrors,
      complete: parsed.complete,
      truncated: parsed.truncated,
      truncatedAt: parsed.truncated ? bytes.length : null,
      warnings: parsed.warnings,
      singlePart: Boolean(parsed.singlePart),
    },
    root: {
      part: root?.index ?? null,
      contentId: root?.contentId ?? null,
      contentType: root?.contentType.type ?? null,
      contentLocation: root?.contentLocation ?? null,
      selection: selection.selection,
      firstPart: root ? root.index === 0 : null,
      declaredStart: parsed.start,
      candidates: selection.matches.map(match => match.index),
      usable,
      problems: rootProblems,
    },
    usable,
    parts: parts.map(part => {
      const decoded = ['base64', 'quoted-printable'].includes(part.transferEncoding) ? decodePartBody(part) : null;
      return {
        index: part.index,
        depth: part.depth,
        parent: part.parent?.index ?? null,
        kind: part.kind,
        contentType: part.contentType.type,
        contentTypeParameters: part.contentType.parameters,
        contentId: part.contentId,
        contentLocation: part.contentLocation,
        contentBase: part.contentBase,
        normalizedLocation: part.locationUrl,
        transferEncoding: part.transferEncoding,
        headers: part.headers,
        raw: { offset: part.rawOffset, length: part.rawLength, digest: part.rawDigest },
        decoded: decoded ? {
          encoding: decoded.encoding,
          length: decoded.bytes.length,
          digest: hashBytes(decoded.bytes),
          invalid: decoded.invalid,
        } : null,
        children: part.children.map(child => child.index),
        truncated: part.truncated,
        headerComplete: part.headerComplete,
        headerTruncated: Boolean(part.headerTruncated),
        headerErrors: part.headerErrors,
        issues: issuesForPart(part),
      };
    }),
    documents,
    resources,
    references: allReferences,
    missing: allReferences
      .filter(reference => reference.status === 'missing')
      .map(reference => ({
        reference: reference.id,
        part: reference.sourcePart,
        value: reference.value,
        normalizedUrl: reference.normalizedUrl,
        via: reference.via,
        external: Boolean(reference.external),
        reason: reference.missingReason,
      })),
    ambiguous: allReferences
      .filter(reference => reference.status === 'ambiguous')
      .map(reference => ({
        reference: reference.id,
        part: reference.sourcePart,
        value: reference.value,
        ...reference.ambiguity,
      })),
    cycles,
    unreferencedParts,
    counts: {
      parts: parts.length,
      documents: documents.length,
      resources: resources.length,
      references: allReferences.length,
      missing: referenceCounts.missing ?? 0,
      ambiguous: referenceCounts.ambiguous ?? 0,
      resolved: referenceCounts.resolved ?? 0,
      blocked: referenceCounts.blocked ?? 0,
      cycles: cycles.length,
      byKind,
      byType,
    },
    diagnostics,
  };
}
