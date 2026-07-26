import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const agentRoot = path.resolve(import.meta.dirname, '../../..');
const repositoryRoot = path.resolve(agentRoot, '..');
const readAgent = (relativePath: string) => fs.readFileSync(path.join(agentRoot, relativePath), 'utf8');
const readRepository = (relativePath: string) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

test('workspace runtime owns browser session boundaries', () => {
    const workspaceSrc = readAgent('src/runtime/workspace/workspace.ts');
    const registrySrc = readAgent('src/runtime/workspace/registry.ts');
    const indexSrc = readAgent('src/index.ts');

    assert.match(workspaceSrc, /browserSession: WorkspaceBrowserSession/);
    assert.match(registrySrc, /userDataRoot/);
    assert.match(registrySrc, /createWorkspaceBrowserSession/);
    assert.equal(indexSrc.includes('await contextManager.getContext()'), false);
    assert.equal(indexSrc.includes('startActionWsClient'), false);
});

test('setActive actions are forwarded through workspace browser session', () => {
    const workspaceGatewaySrc = readAgent('src/actions/workspace_gateway.ts');
    const controlPlaneSrc = readAgent('src/runtime/control_plane.ts');

    assert.match(workspaceGatewaySrc, /action\.type === 'tab\.setActive'[\s\S]*workspace\.browserSession\.emit\(action\)/);
    assert.match(controlPlaneSrc, /case 'workspace\.setActive'[\s\S]*target\.browserSession\.emit\(action\)/);
});

test('extension session uses profile websocket config without bootstrap reset', () => {
    const wsClientSrc = readAgent('src/actions/ws_client.ts');
    const cmdRouterSrc = readRepository('extension/src/background/cmd_router.ts');
    const lifeSrc = readRepository('extension/src/background/life.ts');

    assert.equal(wsClientSrc.includes('17333'), false);
    assert.equal(cmdRouterSrc.includes('WORKFLOW_RESET_DEFAULT'), false);
    assert.equal(cmdRouterSrc.includes('WORKSPACE_LIST'), false);
    assert.equal(lifeSrc.includes('resolveWorkspaceName'), false);
    assert.match(lifeSrc, /sessionWorkspaceName/);
});
