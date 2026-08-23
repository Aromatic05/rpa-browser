import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createAgentControl} from '../../../../src/agent/service/control';
import type {WorkspaceAgentService} from '../../../../src/agent/service/runtime';

const runResult = {
    provider: 'p',
    model: 'm',
    text: 'done',
    trace: {
        metrics: {
            turns: 1,
            toolCalls: 0,
            readCalls: 0,
            controlCalls: 0,
            effectCalls: 0,
            failedToolCalls: 0,
            postErrorEffectCalls: 0,
        },
        tools: [],
    },
};

const action = (type: string, payload: unknown = {}) => ({
    v: 1 as const,
    id: crypto.randomUUID(),
    type,
    workspaceName: 'ws',
    payload,
});

const createHarness = () => {
    let status: 'stopped' | 'running' = 'stopped';
    const service: WorkspaceAgentService = {
        name: 'agent',
        workspaceName: 'ws',
        start: async () => {
            status = 'running';
            return {serviceName: 'agent', workspaceName: 'ws', port: 12345, status};
        },
        stop: async () => {
            status = 'stopped';
            return {serviceName: 'agent', workspaceName: 'ws', status};
        },
        status: () => ({
            serviceName: 'agent', workspaceName: 'ws', port: status === 'running' ? 12345 : null, status,
        }),
        run: async () => runResult,
    };
    const control = createAgentControl(service);
    const workspace = {name: 'ws', agent: control} as any;
    const input = (type: string, payload?: unknown) => ({
        action: action(type, payload),
        workspace,
        workspaceRegistry: {} as any,
    });
    return {control, input};
};

test('agent control delegates service lifecycle', async () => {
    const {control, input} = createHarness();
    const started = await control.handle(input('agent.start'));
    assert.equal((started.reply.payload as any).serviceName, 'agent');
    assert.equal((started.reply.payload as any).status, 'running');
    const status = await control.handle(input('agent.status'));
    assert.equal((status.reply.payload as any).port, 12345);
    const stopped = await control.handle(input('agent.stop'));
    assert.equal((stopped.reply.payload as any).status, 'stopped');
});

test('agent control validates and delegates run requests', async () => {
    const {control, input} = createHarness();
    const response = await control.handle(input('agent.run', {prompt: 'go', provider: 'p', model: 'm'}));
    assert.deepEqual(response.reply.payload, runResult);
    await assert.rejects(
        () => control.handle(input('agent.run', {provider: 'p', model: 'm'})),
        /prompt is required/,
    );
});
