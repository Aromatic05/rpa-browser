import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runBrowserTool } from '../../src/control/tool_bridge';
import type { ControlRouterContext } from '../../src/control/router';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import type { StepUnion } from '../../src/runner/steps/types';

type CapturedCall = {
    name: string;
    args: Record<string, unknown>;
    meta?: Record<string, unknown>;
};

const createContext = (calls: CapturedCall[]): ControlRouterContext => ({
    deps:
        ({
            runtime: {
                ensureActivePage: async () => ({
                    workspaceId: 'ws-control',
                    tabId: 'tab-control',
                    tabToken: 'tk-control',
                    traceCtx: { cache: {} },
                }),
            },
            config: {} as any,
            pluginHost: {
                getExecutors: () =>
                    ({
                        'browser.click': async (step: StepUnion) => {
                            calls.push({
                                name: step.name,
                                args: step.args as Record<string, unknown>,
                                meta: step.meta as Record<string, unknown> | undefined,
                            });
                            return { stepId: step.id, ok: true, data: { clicked: true } };
                        },
                        'browser.fill': async (step: StepUnion) => {
                            calls.push({
                                name: step.name,
                                args: step.args as Record<string, unknown>,
                                meta: step.meta as Record<string, unknown> | undefined,
                            });
                            return { stepId: step.id, ok: true, data: { filled: true } };
                        },
                        'browser.query': async (step: StepUnion) => {
                            calls.push({
                                name: step.name,
                                args: step.args as Record<string, unknown>,
                                meta: step.meta as Record<string, unknown> | undefined,
                            });
                            return { stepId: step.id, ok: true, data: { kind: 'nodeId', nodeId: 'buyer-input' } };
                        },
                        'browser.snapshot': async (step: StepUnion) => {
                            calls.push({
                                name: step.name,
                                args: step.args as Record<string, unknown>,
                                meta: step.meta as Record<string, unknown> | undefined,
                            });
                            return { stepId: step.id, ok: true, data: { snapshot: true } };
                        },
                    }) as any,
            } as any,
        }) as RunStepsDeps,
});

test('browser.click generates a step and executes through the task runner', async () => {
    const calls: CapturedCall[] = [];

    const result = await runBrowserTool(
        'browser.click',
        {
            workspaceId: 'ws-control',
            args: { nodeId: 'buyer-input' },
        },
        createContext(calls),
    );

    assert.equal((result as { ok: boolean }).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'browser.click');
    assert.deepEqual(calls[0]?.args, { nodeId: 'buyer-input' });
    assert.equal(calls[0]?.meta?.source, 'control-rpc');
});

test('browser.fill generates a step and executes through the task runner', async () => {
    const calls: CapturedCall[] = [];

    const result = await runBrowserTool(
        'browser.fill',
        {
            workspaceId: 'ws-control',
            args: { nodeId: 'buyer-input', value: 'alice' },
        },
        createContext(calls),
    );

    assert.equal((result as { ok: boolean }).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'browser.fill');
    assert.deepEqual(calls[0]?.args, { nodeId: 'buyer-input', value: 'alice' });
});

test('browser.query returns the full StepResult', async () => {
    const calls: CapturedCall[] = [];

    const result = await runBrowserTool(
        'browser.query',
        {
            workspaceId: 'ws-control',
            args: {
                op: 'entity.target',
                businessTag: 'order.form',
                target: { kind: 'form.field', fieldKey: 'buyer' },
            },
        },
        createContext(calls),
    );

    assert.equal((result as { ok: boolean }).ok, true);
    assert.equal(typeof (result as { stepId: string }).stepId, 'string');
    assert.equal(calls[0]?.name, 'browser.query');
});

test('tool_bridge does not call runStepList directly', () => {
    const source = fs.readFileSync(
        path.resolve(process.cwd(), 'src/control/tool_bridge.ts'),
        'utf8',
    );

    assert.equal(source.includes('runStepList'), false);
    assert.equal(source.includes('createDslTaskRunner'), true);
});
