import test from 'node:test';
import assert from 'node:assert/strict';
import { runStepList } from '../../../src/runner/run_steps';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';

type StubCall = {
    op: string;
    args: Record<string, unknown>;
};

const createDeps = (calls: StubCall[], opts?: { noActivePage?: boolean }): RunStepsDeps => {
    const binding = {
        workspaceName: 'ws-ref',
        tabName: 'tab-ref',
        tabName: 'tk-ref',
        traceCtx: { cache: {} as Record<string, unknown> },
    };

    return {
        runtime: {
            ensureActivePage: async () => {
                if (opts?.noActivePage) {
                    throw new Error('active page not found');
                }
                return binding;
            },
        } as any,
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        const args = step.args as Record<string, unknown>;
                        if (args['op'] === 'entity.target') {
                            const target = args['target'] as { kind?: string } | undefined;
                            if (target?.kind === 'form.field') {
                                return {
                                    stepId: step.id,
                                    ok: true,
                                    data: {
                                        kind: 'nodeId',
                                        nodeId: 'input_buyer',
                                    },
                                };
                            }
                            return {
                                stepId: step.id,
                                ok: true,
                                data: {
                                    kind: 'nodeId',
                                    nodeId: 'submit_button',
                                },
                            };
                        }
                        if (args['op'] === 'count') {
                            return {
                                stepId: step.id,
                                ok: true,
                                data: {
                                    kind: 'value',
                                    value: 30,
                                },
                            };
                        }
                        if (args['op'] === 'fail') {
                            return {
                                stepId: step.id,
                                ok: false,
                                error: {
                                    code: 'ERR_NOT_FOUND',
                                    message: 'query failed',
                                },
                            };
                        }
                        return {
                            stepId: step.id,
                            ok: true,
                            data: {
                                kind: 'nodeIds',
                                nodeIds: ['row_1', 'row_2'],
                                count: 2,
                            },
                        };
                    },
                    'browser.fill': async (step: StepUnion) => {
                        calls.push({ op: 'fill', args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { ok: true } };
                    },
                    'browser.click': async (step: StepUnion) => {
                        calls.push({ op: 'click', args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { ok: true } };
                    },
                    'browser.select_option': async (step: StepUnion) => {
                        calls.push({ op: 'select_option', args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { ok: true } };
                    },
                }) as any,
        } as any,
    };
};

const runWithSteps = async (steps: StepUnion[], opts?: { stopOnError?: boolean }) => {
    const calls: StubCall[] = [];
    const { checkpoint, pipe } = await runStepList('ws-ref', steps, createDeps(calls), {
        runId: 'run-ref-1',
        stopOnError: opts?.stopOnError,
    });
    return { checkpoint, calls, results: pipe.items };
};

const runWithCustomDeps = async (steps: StepUnion[], deps: RunStepsDeps, opts?: { stopOnError?: boolean }) => {
    const { checkpoint, pipe } = await runStepList('ws-ref', steps, deps, {
        runId: 'run-ref-1',
        stopOnError: opts?.stopOnError,
    });
    return { checkpoint, results: pipe.items };
};

test('runner resolves query result refs for nodeId/value/nodeIds and composes action steps', async () => {
    const { checkpoint, calls, results } = await runWithSteps([
        {
            id: 'resolveField',
            name: 'browser.query',
            args: {
                op: 'entity.target',
                businessTag: 'order.form.main',
                target: { kind: 'form.field', fieldKey: 'buyer' },
            },
        } as StepUnion,
        {
            id: 'fillBuyer',
            name: 'browser.fill',
            args: {
                nodeId: '{{resolveField.data.nodeId}}',
                value: '张三',
            },
        } as StepUnion,
        {
            id: 'resolveSubmit',
            name: 'browser.query',
            args: {
                op: 'entity.target',
                businessTag: 'order.form.main',
                target: { kind: 'form.action', actionIntent: 'submit' },
            },
        } as StepUnion,
        {
            id: 'clickSubmit',
            name: 'browser.click',
            args: {
                nodeId: '{{resolveSubmit.data.nodeId}}',
            },
        } as StepUnion,
        {
            id: 'queryRows',
            name: 'browser.query',
            args: {
                op: 'rows',
            },
        } as StepUnion,
        {
            id: 'selectRow',
            name: 'browser.select_option',
            args: {
                nodeId: '{{queryRows.data.nodeIds.0}}',
                values: ['approved'],
            },
        } as StepUnion,
        {
            id: 'queryCount',
            name: 'browser.query',
            args: {
                op: 'count',
            },
        } as StepUnion,
        {
            id: 'clickWithTimeout',
            name: 'browser.click',
            args: {
                nodeId: 'submit_button',
                timeout: '{{queryCount.data.value}}',
            },
        } as StepUnion,
    ]);

    assert.equal(checkpoint.status, 'completed');
    assert.equal(results.every((item) => item.ok), true);
    assert.deepEqual(calls, [
        {
            op: 'fill',
            args: {
                nodeId: 'input_buyer',
                value: '张三',
            },
        },
        {
            op: 'click',
            args: {
                nodeId: 'submit_button',
            },
        },
        {
            op: 'select_option',
            args: {
                nodeId: 'row_1',
                values: ['approved'],
            },
        },
        {
            op: 'click',
            args: {
                nodeId: 'submit_button',
                timeout: 30,
            },
        },
    ]);
});

test('runner returns ERR_BAD_ARGS when referenced step does not exist', async () => {
    const { checkpoint, results } = await runWithSteps([
        {
            id: 'clickMissing',
            name: 'browser.click',
            args: {
                nodeId: '{{missingStep.data.nodeId}}',
            },
        } as StepUnion,
    ]);

    assert.equal(checkpoint.status, 'failed');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'ERR_BAD_ARGS');
});

test('runner returns ERR_DEPENDENCY_FAILED when referenced step is failed', async () => {
    const { checkpoint, results } = await runWithSteps(
        [
            {
                id: 'qFail',
                name: 'browser.query',
                args: {
                    op: 'fail',
                },
            } as StepUnion,
            {
                id: 'clickAfterFailedDep',
                name: 'browser.click',
                args: {
                    nodeId: '{{qFail.data.nodeId}}',
                },
            } as StepUnion,
        ],
        { stopOnError: false },
    );

    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error?.code, 'ERR_DEPENDENCY_FAILED');
});

test('runner returns ERR_BAD_ARGS when ref path is missing', async () => {
    const { checkpoint, results } = await runWithSteps([
        {
            id: 'qRows',
            name: 'browser.query',
            args: {
                op: 'rows',
            },
        } as StepUnion,
        {
            id: 'clickMissingPath',
            name: 'browser.click',
            args: {
                nodeId: '{{qRows.data.unknownPath}}',
            },
        } as StepUnion,
    ]);

    assert.equal(checkpoint.status, 'failed');
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error?.code, 'ERR_BAD_ARGS');
});

test('runner returns ERR_BAD_ARGS for partial interpolation strings', async () => {
    const { checkpoint, results } = await runWithSteps([
        {
            id: 'qRows',
            name: 'browser.query',
            args: {
                op: 'rows',
            },
        } as StepUnion,
        {
            id: 'clickPartialRef',
            name: 'browser.click',
            args: {
                id: 'prefix-{{qRows.data.nodeIds.0}}',
            },
        } as StepUnion,
    ]);

    assert.equal(checkpoint.status, 'failed');
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error?.code, 'ERR_BAD_ARGS');
});

test('runner does not require active page for no-ref step args', async () => {
    const deps = createDeps([], { noActivePage: true });
    const { checkpoint, results } = await runWithCustomDeps([
        {
            id: 'qRows',
            name: 'browser.query',
            args: {
                op: 'rows',
            },
        } as StepUnion,
    ], deps);

    assert.equal(checkpoint.status, 'completed');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
});
