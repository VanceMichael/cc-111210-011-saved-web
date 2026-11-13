import { createHash } from 'node:crypto';
import { get } from './http.mjs';
import { parseHeaders } from './mime.mjs';
import { analyzePackage } from './capture.mjs';
export { splitHeaders } from './mime.mjs';

/**
 * Download the package once and stop at a hard byte limit. Bytes are hashed
 * while they arrive; the full body is kept only up to the limit so a large
 * attachment cannot be buffered without bound.
 */
export async function fetchPackage(base, options = {}) {
  const maxBytes = Number(options.maxBytes ?? process.env.CAPTURE_MAX_BYTES ?? 16 * 1024 * 1024);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('包大小上限无效');
  const path = '/saved.mhtml?kind=' + encodeURIComponent(options.kind ?? 'normal');
  const response = await get(base, path, {
    timeoutMs: Number(options.timeoutMs ?? 5000),
  });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw Object.assign(new Error(`包大小 ${declared} 字节超过上限 ${maxBytes}`), {
      code: 'PACKAGE_TOO_LARGE',
      limit: maxBytes,
      declared,
    });
  }
  const hash = createHash('sha256');
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maxBytes) {
        // Keep nothing beyond the limit: stop reading and reject the package.
        hash.update(value.subarray(0, value.length - (total - maxBytes)));
        await reader.cancel('超过包大小上限').catch(() => {});
        throw Object.assign(new Error(`包超过上限 ${maxBytes} 字节，已停止接收`), {
          code: 'PACKAGE_TOO_LARGE',
          limit: maxBytes,
          received: total,
        });
      }
      hash.update(value);
      chunks.push(Buffer.from(value));
    }
  }
  return {
    bytes: Buffer.concat(chunks, total),
    digest: hash.digest('hex'),
    received: total,
    contentType: response.headers.get('content-type'),
  };
}

/**
 * Fetch and analyse one saved web package. Nothing in the material is opened:
 * external addresses are only compared against parts already in the package.
 */
export async function inspect(base, options = {}) {
  const fetched = await fetchPackage(base, options);
  const analysis = analyzePackage(fetched.bytes, {
    packageUrl: new URL('/saved.mhtml', base).href,
    maxParts: options.maxParts,
    maxDepth: options.maxDepth,
    maxDocumentChars: options.maxDocumentChars,
    maxPreviewBytes: options.maxPreviewBytes,
  });
  const header = parseHeaders(fetched.bytes, 0, fetched.bytes.length);
  return {
    // Legacy viewer fields.
    headers: header.headers,
    bytes: fetched.bytes.length,
    bodyPreview: fetched.bytes.subarray(header.bodyStart, header.bodyStart + 120).toString('latin1'),
    digest: fetched.digest,
    // Traceable capture result.
    package: analysis.package,
    root: analysis.root,
    usable: analysis.usable,
    parts: analysis.parts,
    documents: analysis.documents,
    resources: analysis.resources,
    references: analysis.references,
    missing: analysis.missing,
    ambiguous: analysis.ambiguous,
    cycles: analysis.cycles,
    unreferencedParts: analysis.unreferencedParts,
    counts: analysis.counts,
    diagnostics: analysis.diagnostics,
  };
}
