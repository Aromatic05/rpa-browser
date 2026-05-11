import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('content bridge and agent page registry use unified tabName key', () => {
    const repoRoot = path.resolve(process.cwd(), '..');
    const contentBridge = fs.readFileSync(path.join(repoRoot, 'extension/src/content/token_bridge.ts'), 'utf-8');
    const contentEntry = fs.readFileSync(path.join(repoRoot, 'extension/src/entry/content.ts'), 'utf-8');
    const agentIndex = fs.readFileSync(path.join(repoRoot, 'agent/src/index.ts'), 'utf-8');
    assert.match(contentBridge, /const TAB_NAME_KEY = '__rpa_tab_name'/);
    assert.match(contentEntry, /sessionStorage\.setItem\('__rpa_tab_name'/);
    assert.match(agentIndex, /const TAB_NAME_KEY = '__rpa_tab_name'/);
    assert.doesNotMatch(contentBridge, /__rpa_tab_token|__RPA_TAB_TOKEN__|__TAB_TOKEN__/);
    assert.doesNotMatch(contentEntry, /__rpa_tab_token|__RPA_TAB_TOKEN__|__TAB_TOKEN__/);
});
