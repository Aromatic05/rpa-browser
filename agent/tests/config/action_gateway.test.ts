import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActionEnvelope } from '../../src/actions/envelope';
import { classifyActionRoute } from '../../src/actions/classify';
import { routeWorkspaceAction } from '../../src/actions/workspace_gateway';
import { routeControlAction } from '../../src/actions/control_gateway';
import { createActionDispatcher } from '../../src/actions/dispatcher';
import type { Action } from '../../src/actions/action_protocol';
import { isRequestActionType } from '../../src/actions/action_types';
import fs from 'node:fs';
import path from 'node:path';

const baseAction = (type: string): Action => ({ v: 1, id: 'a1', type });

const deps = {
    workspaceRegistry: {
        getWorkspace: (_name: string) => null,
        listWorkspaces: () => [],
        getActiveWorkspace: () => null,
    },
    log: () => undefined,
};

test('envelope rejects legacy top-level address fields', () => {
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), scope: {} } as unknown as Action), /scope/);
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), tabToken: 't-1' } as unknown as Action), /tabToken/);
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), tabName: 'tab-1' } as unknown as Action), /tabName/);
});

test('envelope rejects legacy payload address fields', () => {
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), payload: { workspaceName: 'ws-1' } }), /workspaceName/);
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), payload: { scope: { tab: 'x' } } }), /scope/);
});

test('classify distinguishes control/workspace/reply/event', () => {
    assert.equal(classifyActionRoute(baseAction('workflow.list')), 'control');
    assert.equal(classifyActionRoute({ ...baseAction('tab.list'), workspaceName: 'ws-1' }), 'workspace');
    assert.equal(classifyActionRoute(baseAction('workflow.list.result')), 'reply');
    assert.equal(classifyActionRoute(baseAction('play.progress')), 'event');
    assert.equal(classifyActionRoute(baseAction('bad-type')), 'invalid');
});

test('workspace gateway rejects missing workspaceName', async () => {
    const result = await routeWorkspaceAction(deps as any, baseAction('tab.list'));
    assert.equal(result.type, 'tab.list.failed');
});

test('workspace gateway returns failed action when workspace is missing', async () => {
    const action = { ...baseAction('tab.list'), workspaceName: 'ws-missing' };
    const result = await routeWorkspaceAction(deps as any, action);
    assert.equal(result.type, 'tab.list.failed');
    assert.match(String((result.payload as any)?.message || ''), /workspace not found/);
});

test('control gateway does not process workspace actions', async () => {
    await assert.rejects(async () => await routeControlAction(deps as any, { ...baseAction('workflow.list'), workspaceName: 'ws-1' }), /does not accept workspace action/);
});

test('dispatcher routes action without workspaceName to control gateway', async () => {
    const dispatcher = createActionDispatcher({
        workspaceRegistry: deps.workspaceRegistry as any,
        log: deps.log,
    });
    const reply = await dispatcher.dispatch(baseAction('workflow.list'));
    assert.equal(reply.type, 'workflow.list.result');
});

test('dispatcher does not route reply/event into domain control', async () => {
    const dispatcher = createActionDispatcher({
        workspaceRegistry: deps.workspaceRegistry as any,
        log: deps.log,
    });
    const replyAction = await dispatcher.dispatch(baseAction('workflow.list.result'));
    const eventAction = await dispatcher.dispatch(baseAction('play.progress'));
    assert.equal(replyAction.type, 'workflow.list.result.failed');
    assert.equal(eventAction.type, 'play.progress.failed');
});

test('static boundaries: no legacy handler table or execute imports in action index', () => {
    const repoRoot = path.resolve(process.cwd(), 'src/actions');
    assert.equal(fs.existsSync(path.join(repoRoot, 'legacy_handlers.ts')), false);
    assert.equal(fs.existsSync(path.join(repoRoot, 'recording.ts')), false);
    assert.equal(fs.existsSync(path.join(repoRoot, 'task_stream.ts')), false);
    const indexContent = fs.readFileSync(path.join(repoRoot, 'index.ts'), 'utf8');
    assert.equal(indexContent.includes('./execute'), false);
    assert.equal(indexContent.includes('./recording'), false);
    assert.equal(indexContent.includes('./workflow'), false);
    assert.equal(indexContent.includes('./task_stream'), false);
});

test('replay domain ownership boundaries', () => {
    const srcRoot = path.resolve(process.cwd(), 'src');
    const recordControl = fs.readFileSync(path.join(srcRoot, 'record/control.ts'), 'utf8');
    assert.equal(recordControl.includes('../play/replay'), false);
    assert.equal(fs.existsSync(path.join(srcRoot, 'play/replay.ts')), false);
    assert.equal(fs.existsSync(path.join(srcRoot, 'record/replay.ts')), true);
});

test('workflow.dsl.* and workflow.releaseRun are not in request catalog', () => {
    assert.equal(isRequestActionType('workflow.dsl.get'), false);
    assert.equal(isRequestActionType('workflow.dsl.save'), false);
    assert.equal(isRequestActionType('workflow.dsl.test'), false);
    assert.equal(isRequestActionType('workflow.releaseRun'), false);
});
