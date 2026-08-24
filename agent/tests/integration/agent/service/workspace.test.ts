import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createWorkspaceHarness} from '../../../helpers/workspace_harness';
import {createWorkflowOnFs} from '../../../../src/automation/workflow';
import {stepExecutors} from '../../../../src/automation/runner/steps/executors';

test('workspace routes agent.run through pi baseline and existing browser handlers', async () => {
    const faux = createFauxCore({provider: 'workspace-faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.list_tabs', {})),
        fauxAssistantMessage('Observed the workspace tab.'),
    ]);
    const {registry} = createWorkspaceHarness({
        pluginHost: {getExecutors: () => stepExecutors} as any,
        agentModelRuntime: {
            resolve: (provider, model) => provider === 'workspace-faux' && model === 'baseline'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });
    const workspaceName = `agent-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    workspace.tabs.createTab({tabName: 'main'});
    workspace.tabs.bindPage('main', {url: () => 'https://example.test/', isClosed: () => false} as any);

    const request = {
        v: 1 as const,
        id: crypto.randomUUID(),
        type: 'agent.run',
        workspaceName,
        payload: {
            prompt: 'Inspect the open tabs.',
            provider: 'workspace-faux',
            model: 'baseline',
        },
    };
    const result = await workspace.router.handle(request, workspace, registry);
    const payload = result.reply.payload as any;

    assert.equal(result.reply.type, 'agent.run.result');
    assert.equal(payload.text, 'Observed the workspace tab.');
    assert.equal(payload.trace.metrics.toolCalls, 1);
    assert.equal(payload.trace.metrics.readCalls, 1);
    assert.equal(payload.trace.metrics.failedToolCalls, 0);
    assert.equal(workspace.state, 'idle');
});
