import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('workspace runtime owns browser session boundaries', () => {
    const workspaceSrc = read('src/runtime/workspace/workspace.ts');
    const registrySrc = read('src/runtime/workspace/registry.ts');
    const indexSrc = read('src/index.ts');

    assert.match(workspaceSrc, /browserSession: WorkspaceBrowserSession/);
    assert.match(registrySrc, /userDataRoot/);
    assert.match(registrySrc, /createWorkspaceBrowserSession/);
    assert.equal(indexSrc.includes('await contextManager.getContext()'), false);
    assert.equal(indexSrc.includes('startActionWsClient'), false);
});

test('extension session uses profile websocket config without bootstrap reset', () => {
    const wsClientSrc = read('../extension/src/actions/ws_client.ts');
    const cmdRouterSrc = read('../extension/src/background/cmd_router.ts');
    const lifeSrc = read('../extension/src/background/life.ts');

    assert.equal(wsClientSrc.includes('17333'), false);
    assert.equal(cmdRouterSrc.includes('WORKFLOW_RESET_DEFAULT'), false);
    assert.equal(cmdRouterSrc.includes('WORKSPACE_LIST'), false);
    assert.equal(lifeSrc.includes('resolveWorkspaceName'), false);
    assert.match(lifeSrc, /sessionWorkspaceName/);
});
