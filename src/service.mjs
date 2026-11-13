import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { ReceiptStore } from './store.mjs';

function optionNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export async function startService({ source, directory, port = 0 }) {
  const store = new ReceiptStore(directory);
  return listen(async url => {
    const query = Object.fromEntries(url.searchParams);
    const options = {
      kind: query.kind,
      maxBytes: optionNumber(query.maxBytes),
      maxParts: optionNumber(query.maxParts),
      maxDepth: optionNumber(query.maxDepth),
      maxDocumentChars: optionNumber(query.maxDocumentChars),
      maxPreviewBytes: optionNumber(query.maxPreviewBytes),
    };
    if (url.pathname === '/health') return { body: { state: 'ready' } };
    if (url.pathname === '/inspect') {
      const result = await inspect(source, options);
      return { body: result };
    }
    if (url.pathname === '/receive') {
      const key = query.key ?? 'single';
      const result = await inspect(source, options);
      // Only a closed, unambiguous dependency graph is accepted. Damaged or
      // ambiguous material is still viewable through /inspect.
      if (!result.usable) {
        return {
          status: 409,
          body: {
            error: '包不满足接收条件',
            usable: false,
            root: result.root,
            counts: result.counts,
            diagnostics: result.diagnostics,
          },
        };
      }
      return { body: await store.save(key, result) };
    }
    if (url.pathname.startsWith('/receipts/')) return { body: await store.read(url.pathname.split('/').pop()) };
    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}
