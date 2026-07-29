import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../../dist/annotator/', import.meta.url));

test('annotator bundle embeds compiled Vue component styles for Shadow DOM injection', async () => {
    const bundle = await readFile(`${dist}annotator.js`, 'utf8');
    assert.match(bundle, /__rpaAnnotatorComponentCss/);
    assert.match(bundle, /\.annotator-canvas\[data-v-/);
    assert.match(bundle, /\.annotator-label-layer\[data-v-/);
    assert.doesNotMatch(bundle, /process\.env\.NODE_ENV/);
    await assert.rejects(stat(`${dist}annotator.css`));
});
