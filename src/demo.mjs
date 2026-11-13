import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'capture-demo-'));
const source = await startFixture();
let service;
try {
  service = await startService({ source: source.url, directory });
  const response = await fetch(service.url + '/inspect');
  const result = await response.json();
  // The demo prints the traceable summary, not the whole package body.
  console.log(JSON.stringify({
    source: source.url,
    status: response.status,
    package: result.package,
    root: result.root,
    usable: result.usable,
    counts: result.counts,
    documents: result.documents.map(document => ({
      part: document.part,
      title: document.title,
      usable: document.usable,
      problems: document.problems,
      encoding: document.encoding,
      references: document.references.map(reference => ({
        id: reference.id,
        value: reference.value,
        base: reference.base,
        lookup: reference.lookupKey,
        status: reference.status,
        target: reference.target,
        candidates: reference.candidates,
      })),
    })),
    resources: result.resources,
    missing: result.missing,
    ambiguous: result.ambiguous,
    cycles: result.cycles,
    unreferencedParts: result.unreferencedParts,
    diagnostics: result.diagnostics,
  }, null, 2));
  if (!response.ok) process.exitCode = 1;
} finally {
  await service?.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
