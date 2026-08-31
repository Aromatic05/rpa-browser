import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../../dist/', import.meta.url));
const dist = `${distRoot}annotator/`;

test('annotator bundle embeds compiled Vue component styles for Shadow DOM injection', async () => {
    const bundle = await readFile(`${dist}annotator.js`, 'utf8');
    assert.match(bundle, /__rpaAnnotatorComponentCss/);
    assert.match(bundle, /\.annotator-canvas\[data-v-/);
    assert.match(bundle, /\.annotator-label-layer\[data-v-/);
    assert.doesNotMatch(bundle, /process\.env\.NODE_ENV/);
    await assert.rejects(stat(`${dist}annotator.css`));
});

test('service worker entry changes on every extension build', async () => {
    const build = JSON.parse(await readFile(`${distRoot}rpa-build.json`, 'utf8'));
    const serviceWorker = await readFile(`${distRoot}entry/sw.js`, 'utf8');
    const manifest = JSON.parse(await readFile(`${distRoot}manifest.json`, 'utf8'));
    assert.equal(manifest.version_name, build.buildId);
    assert.equal(manifest.version, build.manifestVersion);
    assert.notEqual(manifest.version, '0.1.0');
    assert.match(serviceWorker, new RegExp(`^// rpa-extension-build:${build.buildId}`));
    assert.doesNotMatch(serviceWorker, /^import\s/m);
    assert.match(serviceWorker, /entity_rules\.annotator\.open/);
});

test('merged newtab surface is emitted at the manifest-owned path', async () => {
    const manifest = JSON.parse(await readFile(`${distRoot}manifest.json`, 'utf8'));
    const newtabHtml = await readFile(`${distRoot}newtab.html`, 'utf8');
    const newtabEntry = await readFile(`${distRoot}start/newtab.js`, 'utf8');
    assert.equal(manifest.chrome_url_overrides.newtab, 'newtab.html');
    assert.match(newtabHtml, /src="\.\/start\/newtab\.js"/);
    assert.match(newtabEntry, /tab\.report/);
    assert.doesNotMatch(newtabEntry, /tab\.init|tab\.opened/);
});
