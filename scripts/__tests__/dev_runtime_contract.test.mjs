import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const rootPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const runtimeSource = await readFile(new URL('../dev_runtime.mjs', import.meta.url), 'utf8').catch(() => '');

test('dev and dev:cdp share the managed development runtime', () => {
    assert.equal(rootPackage.scripts.dev, 'node scripts/dev_runtime.mjs --mode=extension');
    assert.equal(rootPackage.scripts['dev:cdp'], 'node scripts/dev_runtime.mjs --mode=cdp');
    assert.match(runtimeSource, /dev-runtime\.lock/);
    assert.match(runtimeSource, /test:runner:bundle:watch/);
});

test('start invokes the product runtime directly', () => {
    assert.equal(rootPackage.scripts.start, 'node scripts/product_runtime.mjs');
});

test('development runtime watches only tracked extension inputs', () => {
    assert.equal(runtimeSource.includes('extension/vite.config.ts'), false);
    assert.match(runtimeSource, /existsSync/);
});
