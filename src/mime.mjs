import { createHash } from 'node:crypto';

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const DUMMY_BASE = 'http://mhtml.invalid/';

export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function findLineEnd(bytes, start, end) {
  const newline = bytes.indexOf(0x0a, start);
  if (newline < 0 || newline >= end) return end;
  return newline;
}

/**
 * Parse an entity header block without assuming that the block is complete.
 * Damaged packages are common, so a missing empty line is reported instead of
 * discarding the readable part that follows it.
 */
export function parseHeaders(bytes, start = 0, end = bytes.length, options = {}) {
  const maxHeaderBytes = options.maxHeaderBytes ?? 64 * 1024;
  const headers = {};
  const errors = [];
  let position = start;
  let bodyStart = end;
  let complete = false;
  let currentName = null;
  let headerBytes = 0;
  let truncated = false;

  if (start >= end) {
    // An empty part (a delimiter followed by another delimiter) is valid and
    // has no headers to recover.
    return { headers, errors, bodyStart: end, complete: true, headerBytes, truncated: false };
  }

  while (position < end) {
    if (position - start > maxHeaderBytes) {
      errors.push('头部超过长度上限');
      bodyStart = position;
      break;
    }
    const lineEnd = findLineEnd(bytes, position, end);
    let contentEnd = lineEnd;
    if (contentEnd > position && bytes[contentEnd - 1] === 0x0d) contentEnd -= 1;
    const next = lineEnd < end ? lineEnd + 1 : end;
    headerBytes += next - position;

    if (contentEnd === position) {
      bodyStart = next;
      complete = true;
      break;
    }

    const line = bytes.subarray(position, contentEnd).toString('latin1');
    if ((line[0] === ' ' || line[0] === '\t') && currentName) {
      const values = headers[currentName];
      values[values.length - 1] += ' ' + line.trim();
      position = next;
      continue;
    }
    if ((line[0] === ' ' || line[0] === '\t') && !currentName) {
      errors.push('头部首行不能折行');
      position = next;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon < 1 || /[\s]/.test(line.slice(0, colon)) || !/^[!-9;-~]+$/.test(line.slice(0, colon))) {
      // This line cannot be a header. Treat it (and the rest) as a body so a
      // package with a missing header/body separator still yields content.
      errors.push('头部行无效');
      bodyStart = position;
      break;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      errors.push('头部名称无效');
      position = next;
      continue;
    }
    const value = line.slice(colon + 1).trim();
    (headers[name] ??= []).push(value);
    currentName = name;
    position = next;
  }

  if (!complete && bodyStart === end && position >= end) {
    // Everything looked like headers but the block ran out of bytes.
    bodyStart = end;
    truncated = true;
  }
  if (!complete && !errors.length) errors.push('头部未以空行结束');
  return { headers, errors, bodyStart, complete, headerBytes, truncated };
}

/** Strict header parsing used by the legacy viewer entry. */
export function splitHeaders(bytes) {
  const parsed = parseHeaders(bytes, 0, bytes.length);
  if (!parsed.complete) throw new Error('MIME头未结束');
  if (parsed.errors.length) throw new Error('MIME头无效');
  return {
    headers: parsed.headers,
    body: bytes.subarray(parsed.bodyStart),
    offset: parsed.bodyStart,
  };
}

export function headerValue(headers, name) {
  const values = headers[name.toLowerCase()];
  return values?.[0];
}

function splitParameters(value) {
  const segments = [];
  let current = '';
  let quote = null;
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments;
}

function decodeExtended(value) {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!match) return value;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return match[2];
  }
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return trimmed;
}

export function parseContentType(value) {
  if (!value) return { type: '', parameters: {} };
  const segments = splitParameters(value);
  const type = segments.shift().trim().toLowerCase();
  const parameters = {};
  for (const segment of segments) {
    const equals = segment.indexOf('=');
    if (equals < 1) continue;
    let name = segment.slice(0, equals).trim().toLowerCase();
    let parameter = segment.slice(equals + 1).trim();
    const extended = name.endsWith('*');
    if (extended) name = name.slice(0, -1);
    if (!name || name in parameters) continue;
    parameter = unquote(parameter);
    parameters[name] = extended ? decodeExtended(parameter) : parameter;
  }
  return { type, parameters };
}

export function contentTypeOf(headers) {
  return parseContentType(headerValue(headers, 'content-type'));
}

export function normalizeContentId(value) {
  if (typeof value !== 'string') return null;
  let id = value.trim();
  id = id.replace(/^cid:/i, '');
  try {
    id = decodeURIComponent(id);
  } catch {
    // Keep the literal value when it is not valid percent encoding.
  }
  // Tolerate the doubled angle brackets that appear in hand-edited packages;
  // the id itself never contains them.
  while (id.startsWith('<') && id.endsWith('>') && id.length >= 2) {
    id = id.slice(1, -1).trim();
  }
  return id || null;
}

function normalizePercent(value) {
  return value.replace(/%([0-9a-fA-F]{2})/g, (match, hex) => {
    const code = Number.parseInt(hex, 16);
    const character = String.fromCharCode(code);
    if (/[A-Za-z0-9\-._~]/.test(character)) return character;
    return '%' + hex.toUpperCase();
  });
}

/**
 * URL normalisation is used for lookup only. The original spelling is always
 * kept on the reference and on the part so two spellings of one address can
 * still be reported separately.
 */
export function normalizeUrl(value, base = null) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^data:/i.test(trimmed) || /^javascript:/i.test(trimmed) || /^vbscript:/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, base || DUMMY_BASE);
    url.hash = '';
    url.pathname = normalizePercent(url.pathname);
    url.search = normalizePercent(url.search);
    return url.href;
  } catch {
    return null;
  }
}

export function urlScheme(value) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

const BASE64_CODES = (() => {
  const table = new Int16Array(256).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let index = 0; index < alphabet.length; index += 1) table[alphabet.charCodeAt(index)] = index;
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

export function decodeBase64(bytes) {
  let output = Buffer.allocUnsafe(Math.floor((bytes.length * 3) / 4) + 3);
  let length = 0;
  let accumulator = 0;
  let bits = 0;
  let invalid = 0;
  for (const byte of bytes) {
    if (WS.has(byte)) continue;
    if (byte === 0x3d) continue; // padding
    const code = BASE64_CODES[byte];
    if (code < 0) {
      invalid += 1;
      continue;
    }
    accumulator = ((accumulator << 6) | code) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[length++] = (accumulator >> bits) & 0xff;
    }
  }
  return { bytes: output.subarray(0, length), invalid };
}

const HEX = /^[0-9a-fA-F]$/;

export function decodeQuotedPrintable(bytes) {
  const output = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== 0x3d) {
      output[length++] = byte;
      continue;
    }
    const first = bytes[index + 1];
    const second = bytes[index + 2];
    if (first === 0x0d && second === 0x0a) {
      index += 2;
      continue;
    }
    if (first === 0x0a) {
      index += 1;
      continue;
    }
    const text = String.fromCharCode(first ?? 0, second ?? 0);
    if (HEX.test(text[0]) && HEX.test(text[1])) {
      output[length++] = Number.parseInt(text, 16);
      index += 2;
      continue;
    }
    output[length++] = byte;
  }
  return { bytes: output.subarray(0, length), invalid: 0 };
}

export function decodeTransfer(bytes, encoding) {
  const normalized = (encoding || '7bit').trim().toLowerCase().replace(/;.*$/, '');
  if (normalized === 'base64') {
    const decoded = decodeBase64(bytes);
    return { bytes: decoded.bytes, encoding: normalized, invalid: decoded.invalid };
  }
  if (normalized === 'quoted-printable') {
    const decoded = decodeQuotedPrintable(bytes);
    return { bytes: decoded.bytes, encoding: normalized, invalid: decoded.invalid };
  }
  if (['7bit', '8bit', 'binary', ''].includes(normalized)) {
    return { bytes, encoding: normalized || '7bit', invalid: 0 };
  }
  return { bytes, encoding: normalized, invalid: 0, unsupported: true };
}

function charsetFromMeta(bytes) {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('latin1');
  const direct = /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head);
  if (direct) return direct[1];
  const httpEquiv = /<meta\b[^>]*http-equiv\s*=\s*["']?content["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([A-Za-z0-9._:-]+)/i.exec(head);
  return httpEquiv ? httpEquiv[1] : null;
}

export function decodeText(bytes, headers, options = {}) {
  const contentType = contentTypeOf(headers);
  const html = options.html ?? /html|xhtml/.test(contentType.type);
  let declared = contentType.parameters.charset ?? null;
  let source = declared ? 'content-type' : null;
  let used = declared;

  let bom = null;
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = 'utf-8';
    offset = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    bom = 'utf-16le';
    offset = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    bom = 'utf-16be';
    offset = 2;
  }
  if (bom) {
    declared = bom;
    used = bom;
    source = 'bom';
  }
  if (!used && html) {
    const meta = charsetFromMeta(bytes.subarray(offset));
    if (meta) {
      declared = meta;
      used = meta;
      source = 'meta';
    }
  }
  if (!used) {
    used = 'utf-8';
    source = 'default';
  }

  let decoder;
  const warnings = [];
  try {
    decoder = new TextDecoder(used, { fatal: false });
  } catch {
    warnings.push(`不支持的字符编码 ${used}，按 UTF-8 读取`);
    decoder = new TextDecoder('utf-8', { fatal: false });
  }
  const text = decoder.decode(bytes.subarray(offset));
  let replacements = 0;
  for (const character of text) if (character === '\ufffd') replacements += 1;
  if (replacements) warnings.push(`解码时出现 ${replacements} 个替换字符`);
  return {
    text,
    declared,
    used: decoder.encoding,
    source,
    bom,
    replacements,
    warnings,
  };
}

function findBoundary(bytes, from, end, boundary) {
    const marker = Buffer.from('--' + boundary, 'latin1');
  let position = from;
  const maxBoundaryLength = 1024;
  while (position < end) {
    const index = bytes.indexOf(marker, position);
    if (index < 0 || index >= end) return null;
    const lineStart = index === 0 || bytes[index - 1] === 0x0a;
    if (!lineStart) {
      position = index + 1;
      continue;
    }
    // The delimiter line itself is short; reading further would turn arbitrary
    // content into part of the boundary name.
    let lineEnd = bytes.indexOf(0x0a, index + marker.length);
    if (lineEnd < 0) lineEnd = bytes.length;
    if (lineEnd - index > marker.length + maxBoundaryLength) {
      position = index + 1;
      continue;
    }
    let contentEnd = lineEnd;
    if (contentEnd > index && bytes[contentEnd - 1] === 0x0d) contentEnd -= 1;
    const tail = bytes.subarray(index + marker.length, contentEnd).toString('latin1');
    const trimmed = tail.trim();
    if (trimmed === '' || /^--\s*$/.test(trimmed)) {
      return {
        index,
        lineEnd: lineEnd < end ? Math.min(lineEnd + 1, end) : end,
        close: trimmed.startsWith('--'),
        atEnd: lineEnd >= end,
      };
    }
    position = index + 1;
  }
  return null;
}

function trimBoundaryLineEnd(bytes, start, end) {
  let contentEnd = end;
  if (contentEnd - 2 >= start && bytes[contentEnd - 2] === 0x0d && bytes[contentEnd - 1] === 0x0a) return contentEnd - 2;
  if (contentEnd - 1 >= start && bytes[contentEnd - 1] === 0x0a) return contentEnd - 1;
  return contentEnd;
}

function newPart(context, depth, parent) {
  // Reserve the index from a single counter so multipart containers and their
  // children share one stable numbering.
  context.counter.value += 1;
  const part = {
    index: context.counter.value - 1,
    depth,
    parent,
    children: [],
    headers: {},
    headerErrors: [],
    contentType: { type: '', parameters: {} },
    transferEncoding: '7bit',
    truncated: false,
    headerComplete: true,
    rawBody: null,
    rawOffset: null,
    rawLength: 0,
    rawDigest: null,
    decodedCache: null,
    decodedInfo: null,
  };
  return part;
}

function finalizePart(part, bytes, start, end, context, bodyTruncated) {
  const header = parseHeaders(bytes, start, end, context.headerOptions);
  part.headers = header.headers;
  part.headerErrors = header.errors;
  part.headerComplete = header.complete;
  part.contentType = contentTypeOf(header.headers);
  part.transferEncoding = (headerValue(header.headers, 'content-transfer-encoding') || '7bit').trim().toLowerCase();
  part.bodyStart = header.bodyStart;
  part.bodyEnd = end;
  part.rawBody = bytes.subarray(header.bodyStart, end);
  part.rawOffset = context.offsetBase === null ? null : context.offsetBase + header.bodyStart;
  part.rawLength = part.rawBody.length;
  part.rawDigest = hashBytes(part.rawBody);
  // Missing boundary means the bytes really stop early. A missing header/body
  // separator only damages the headers; the body that follows stays usable.
  if (header.truncated) {
    part.headerTruncated = true;
    if (!bodyTruncated) context.warnings.push(`部分 ${part.index} 的头部在包尾截断`);
  }
  part.truncated = bodyTruncated;
  if (bodyTruncated) context.truncated = true;
  if (header.errors.length && header.complete) {
    context.warnings.push(`部分 ${part.index} 头部存在问题：${header.errors.join('；')}`);
  }
  const disposition = headerValue(header.headers, 'content-disposition');
  if (disposition) part.disposition = disposition;
  part.contentIdRaw = headerValue(header.headers, 'content-id') ?? null;
  part.contentId = normalizeContentId(part.contentIdRaw);
  part.contentLocation = headerValue(header.headers, 'content-location') ?? null;
  part.contentBase = headerValue(header.headers, 'content-base') ?? null;

  if (part.contentType.type.startsWith('multipart/') && context.counter.value < context.maxParts) {
    if (part.truncated || part.headerTruncated) {
      context.warnings.push(`部分 ${part.index} 的多部分容器不完整，未展开嵌套内容`);
      part.malformed = '嵌套多部分不完整';
      return part;
    }
    const boundary = part.contentType.parameters.boundary;
    if (!boundary) {
      context.warnings.push(`部分 ${part.index} 缺少嵌套边界`);
      part.malformed = '缺少嵌套边界';
      return part;
    }
    const decoded = decodeTransfer(part.rawBody, part.transferEncoding);
    const identity = decoded.bytes === part.rawBody;
    // A nested container shares one counter so its children never reuse an
    // index. Nested bodies encoded as base64 have no absolute package offset.
    const nestedContext = identity
      ? context
      : { ...context, counter: context.counter, offsetBase: null };
    const nested = parseMultipartBody(
      identity ? bytes : decoded.bytes,
      identity ? header.bodyStart : 0,
      identity ? end : decoded.bytes.length,
      boundary,
      nestedContext,
      part,
      part.depth + 1,
    );
    part.children = nested.parts;
    if (nested.truncated) part.truncated = true;
    context.warnings.push(...nested.warnings);
    if (!identity) {
      context.warnings.push(`部分 ${part.index} 的嵌套多部分使用了 ${part.transferEncoding}，子部分偏移仅相对于解码后字节`);
    }
  }
  return part;
}

function parseMultipartBody(bytes, start, end, boundary, context, parent, depth) {
  const parts = [];
  const warnings = [];
  let truncated = false;
  if (depth > context.maxDepth) {
    return { parts, truncated: true, warnings: [`嵌套深度超过 ${context.maxDepth}`] };
  }
  const first = findBoundary(bytes, start, end, boundary);
  if (!first) {
    warnings.push('未找到首个多部分边界');
    return { parts, truncated: true, warnings };
  }
  let position = first.lineEnd;
  let open = !first.close;
  while (open && position <= end && context.counter.value < context.maxParts) {
    const next = findBoundary(bytes, position, end, boundary);
    let partEnd;
    const partTruncated = !next;
    if (next) partEnd = trimBoundaryLineEnd(bytes, position, next.index);
    else {
      partEnd = end;
      truncated = true;
    }
    if (partEnd < position) partEnd = position;
    const part = newPart(context, depth, parent);
    finalizePart(part, bytes, position, partEnd, context, partTruncated);
    parts.push(part);
    if (next) {
      if (next.close) open = false;
      position = next.lineEnd;
    } else {
      open = false;
    }
  }
  if (context.counter.value >= context.maxParts) {
    warnings.push(`部分数量达到上限 ${context.maxParts}`);
    truncated = true;
  }
  return { parts, truncated, warnings };
}

/**
 * Parse one MHTML/multipart package. Every part keeps a view of its raw body
 * and the absolute byte range in the package; nothing is fetched.
 */
export function parsePackage(bytes, options = {}) {
  const context = {
    counter: { value: 0 },
    maxParts: options.maxParts ?? 5000,
    maxDepth: options.maxDepth ?? 32,
    offsetBase: 0,
    truncated: false,
    warnings: [],
    headerOptions: { maxHeaderBytes: options.maxHeaderBytes ?? 64 * 1024 },
  };
  const topHeaders = parseHeaders(bytes, 0, bytes.length, context.headerOptions);
  const contentType = contentTypeOf(topHeaders.headers);
  const packageInfo = {
    headers: topHeaders.headers,
    headerErrors: topHeaders.errors,
    contentType,
    boundary: contentType.parameters.boundary ?? null,
    start: contentType.parameters.start ?? null,
    type: contentType.parameters.type ?? null,
    bytes: bytes.length,
    digest: hashBytes(bytes),
    truncated: false,
    complete: true,
    warnings: context.warnings,
    parts: [],
  };

  if (!contentType.type.startsWith('multipart/')) {
    const part = newPart(context, 0, null);
    finalizePart(part, bytes, 0, bytes.length, context, false);
    packageInfo.parts = [part];
    packageInfo.singlePart = true;
    packageInfo.complete = !part.truncated && part.headerComplete;
    packageInfo.truncated = part.truncated || part.headerTruncated === true;
    return packageInfo;
  }
  if (!packageInfo.boundary) {
    packageInfo.complete = false;
    packageInfo.truncated = true;
    packageInfo.warnings.push('multipart 包缺少 boundary');
    return packageInfo;
  }
  const parsed = parseMultipartBody(bytes, topHeaders.bodyStart, bytes.length, packageInfo.boundary, context, null, 1);
  packageInfo.parts = parsed.parts;
  packageInfo.truncated = parsed.truncated || context.truncated;
  packageInfo.complete = !packageInfo.truncated;
  packageInfo.warnings = [...packageInfo.warnings, ...parsed.warnings];
  if (topHeaders.errors.length) {
    packageInfo.warnings.push(...topHeaders.errors);
    packageInfo.complete = false;
  }
  return packageInfo;
}
