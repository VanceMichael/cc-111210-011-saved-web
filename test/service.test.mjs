import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptStore } from '../src/store.mjs';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

test('接收记录支持同内容重复领取并拒绝覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipt-'));
  try {
    const store = new ReceiptStore(directory);
    assert.deepEqual(await store.save('one', { value: 3 }), await store.save('one', { value: 3 }));
    await assert.rejects(store.save('one', { value: 4 }), /冲突/);
    await assert.rejects(store.save('../escape', {}), /无效/);
    const receipt = JSON.parse(await readFile(join(directory, 'one.json'), 'utf8'));
    receipt.value.value = 8;
    await writeFile(join(directory, 'one.json'), JSON.stringify(receipt));
    await assert.rejects(store.read('one'), /校验失败/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('服务健康检查和单次查看走真实来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    assert.equal((await (await fetch(service.url + '/health')).json()).state, 'ready');
    const response = await fetch(service.url + '/inspect');
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.root.part, 1);
    assert.equal(body.root.selection, 'start');
    assert.equal(body.usable, false);
    assert.ok(body.resources.every(resource => resource.raw.digest.length === 64));
    assert.equal((await fetch(service.url + '/missing')).status, 404);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test('不可用包拒绝接收并保留原回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    const rejected = await fetch(service.url + '/receive?key=damaged');
    assert.equal(rejected.status, 409);
    const body = await rejected.json();
    assert.equal(body.usable, false);
    assert.ok(body.diagnostics.some(item => item.code === 'REFERENCE_MISSING'));
    assert.deepEqual(await readdir(directory).catch(() => []), []);

    const truncated = await fetch(service.url + '/receive?key=damaged&kind=truncated');
    assert.equal(truncated.status, 409);
    const truncatedBody = await truncated.json();
    assert.ok(truncatedBody.diagnostics.some(item => item.code === 'PACKAGE_TRUNCATED'));

    const accepted = await fetch(service.url + '/receive?key=good&kind=clean');
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const receipt = await accepted.json();
    assert.equal(receipt.value.usable, true);
    assert.equal(receipt.value.root.part, 1);
    const stored = await (await fetch(service.url + '/receipts/good')).json();
    assert.equal(stored.digest, receipt.digest);

    // A different, unusable payload must not overwrite the stored receipt.
    const conflict = await fetch(service.url + '/receive?key=good');
    assert.equal(conflict.status, 409);
    assert.equal((await (await fetch(service.url + '/receipts/good')).json()).digest, receipt.digest);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test('字节上限在服务入口生效', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    const response = await fetch(service.url + '/inspect?maxBytes=100');
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /超过上限/);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
