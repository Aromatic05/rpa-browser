import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDsl, parseDsl, runDsl, runDslSource } from '../../../../src/automation/dsl';
import { runCheckpointDslBody } from '../../../../src/automation/runner/checkpoint/dsl_body';
import { DslRuntimeError, DslValidationError } from '../../../../src/program/dsl/diagnostics/errors';
import type { DslCheckpointProvider } from '../../../../src/automation/dsl/emit';
import type { RunStepsDeps } from '../../../../src/automation/runner/run_steps';
import type { Checkpoint } from '../../../../src/automation/runner/checkpoint';
import type { StepResolve, StepUnion } from '../../../../src/automation/runner/steps/types';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';

type StubCall = {
    name: string;
    args: Record<string, unknown>;
    resolve?: StepResolve;
};

const createDeps = (calls: StubCall[]): RunStepsDeps =>
    completeRunStepsDeps({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-dsl',
                tabName: 'tk-dsl',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown>, resolve: step.resolve });
                        return {
                            stepId: step.id,
                            ok: true,
                            data: { kind: 'nodeId', nodeId: 'buyer-input' },
                        };
                    },
                    'browser.fill': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown>, resolve: step.resolve });
                        return { stepId: step.id, ok: true, data: { filled: true } };
                    },
                    'browser.click': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown>, resolve: step.resolve });
                        return { stepId: step.id, ok: true, data: { clicked: true } };
                    },
                }) as any,
        } as any,
    });

test('runDsl executes query then fill through one task stream and writes vars/output', async () => {
    const calls: StubCall[] = [];
    const checkpoint: Checkpoint = {
        id: 'ensure_logged_in',
        kind: 'procedure',
        output: {
            loginState: { ref: 'input.username' },
        },
    };
    const checkpointProvider: DslCheckpointProvider = {
        getCheckpoint: (id) => (id === checkpoint.id ? checkpoint : null),
    };

    const program = normalizeDsl(
        parseDsl(`
            use checkpoint "ensure_logged_in" with {
              username: input.username
            }

            let buyer = query entity.target "order.form" {
              kind: "form.field"
              fieldKey: "buyer"
            }

            fill buyer with input.user.name
        `),
    );

    const result = await runDsl(program, {
        workspaceName: 'ws-dsl',
        deps: createDeps(calls),
        checkpointProvider,
        input: {
            username: 'root',
            user: { name: 'alice' },
        },
    });

    assert.deepEqual(
        calls.map((item) => item.name),
        ['browser.query', 'browser.fill'],
    );
    assert.deepEqual(result.scope.vars, {
        buyer: { nodeId: 'buyer-input' },
    });
    assert.deepEqual(calls[1].args, {
        nodeId: 'buyer-input',
        value: 'alice',
    });
    assert.deepEqual(result.scope.output, {});
});

test('runDsl checkpoint applies resolve sidecar without retaining resolveId', async () => {
    const calls: StubCall[] = [];
    const checkpoint: Checkpoint = {
        id: 'repair_session',
        kind: 'procedure',
        content: [{
            type: 'act',
            step: {
                name: 'browser.click',
                args: {resolveId: 'dismiss-button'},
            },
        }],
    };
    const resolve: StepResolve = {hint: {raw: {selector: '#dismiss'}}};
    const checkpointProvider: DslCheckpointProvider = {
        getCheckpoint: (id) => id === checkpoint.id ? checkpoint : null,
        getCheckpointResolves: (id) => id === checkpoint.id ? {'dismiss-button': resolve} : null,
    };

    await runDsl(normalizeDsl(parseDsl('use checkpoint "repair_session"')), {
        workspaceName: 'ws-dsl',
        deps: createDeps(calls),
        checkpointProvider,
    });

    const click = calls.find((item) => item.name === 'browser.click');
    assert.ok(click);
    assert.equal('resolveId' in click.args, false);
    assert.deepEqual(click.resolve, resolve);
});

test('runDsl keeps legacy action-model checkpoints callable when kind is omitted', async () => {
    const calls: StubCall[] = [];
    const checkpoint: Checkpoint = {id: 'legacy', content: [{type: 'act', step: {name: 'browser.click', args: {selector: '#legacy'}}}]};
    await runDsl(normalizeDsl(parseDsl('use checkpoint "legacy"')), {
        workspaceName: 'ws-dsl', deps: createDeps(calls), checkpointProvider: {getCheckpoint: () => checkpoint},
    });
    assert.equal(calls[0]?.name, 'browser.click');
});

test('runDsl executes a procedure DSL body through the current step port and binds its output', async () => {
    const calls: StubCall[] = [];
    const checkpoint: Checkpoint = {id: 'ensure', kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}};
    const result = await runDsl(normalizeDsl(parseDsl(`
        let session = use checkpoint "ensure" with {
          authenticated: input.authenticated
          target: input.target
        }
        fill input.target with session.authenticated
    `)), {
        workspaceName: 'ws-dsl', deps: createDeps(calls), input: {authenticated: 'yes', target: {nodeId: 'target'}},
        checkpointProvider: {
            getCheckpoint: (id) => id === 'ensure' ? checkpoint : null,
            getCheckpointBody: () => ({source: 'click input.target\noutput authenticated = input.authenticated', stepResolves: {}}),
        },
    });
    assert.deepEqual(calls.map((call) => call.name), ['browser.click', 'browser.fill']);
    assert.deepEqual(calls[1].args, {nodeId: 'target', value: 'yes'});
    assert.deepEqual(result.scope.vars.session, {authenticated: 'yes'});
    assert.deepEqual(result.scope.output, {});
});

test('checkpoint DSL bodies expose an immutable failure root while normal DSL cannot reference it', async () => {
    const checkpoint: Checkpoint = {id: 'recover', kind: 'recovery', body: {language: 'dsl', source: 'body.dsl'}};
    const output = await runCheckpointDslBody({
        checkpoint,
        source: `
            output step = failure.step.name
            output code = failure.error.code
            output message = failure.error.message
            output attempt = failure.attempt
            output maxAttempts = failure.maxAttempts
            output url = failure.url
        `,
        stepResolves: {},
        executeStep: async (step) => ({stepId: step.id, ok: true}),
        workspaceName: 'ws-dsl',
        deps: createDeps([]),
        failure: {
            step: {name: 'browser.click'},
            error: {code: 'ERR_CLICK', message: 'not found'},
            attempt: 2,
            maxAttempts: 3,
            url: 'https://example.test/failed',
        },
    });
    assert.deepEqual(output, {
        step: 'browser.click', code: 'ERR_CLICK', message: 'not found', attempt: 2, maxAttempts: 3,
        url: 'https://example.test/failed',
    });
    await assert.rejects(
        () => runDslSource('output leaked = failure.error.code', {workspaceName: 'ws-dsl', deps: createDeps([])}),
        (error: unknown) => error instanceof DslValidationError,
    );
});

test('recovery DSL child scopes retain the read-only failure root', async () => {
    const output = await runCheckpointDslBody({
        checkpoint: {id: 'recover-children', kind: 'recovery', body: {language: 'dsl', source: 'body.dsl'}},
        source: `
            if failure.error.code:
              output fromIf = failure.step.name
            for item in failure.items:
              output fromFor = failure.error.message
        `,
        stepResolves: {}, executeStep: async (step) => ({stepId: step.id, ok: true}),
        workspaceName: 'ws-dsl', deps: createDeps([]),
        failure: {step: {name: 'browser.click'}, error: {code: 'ERR_CLICK', message: 'not found'}, items: [1]},
    });
    assert.deepEqual(output, {fromIf: 'browser.click', fromFor: 'not found'});
});

test('DSL checkpoint calls only procedures and detect direct, indirect, and deep recursion', async () => {
    const checkpoint = (id: string, source: string): Checkpoint => ({id, kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}});
    const direct = checkpoint('direct', 'use checkpoint "direct"');
    const first = checkpoint('first', 'use checkpoint "second"');
    const second = checkpoint('second', 'use checkpoint "first"');
    const recovery: Checkpoint = {id: 'recovery', kind: 'recovery', body: {language: 'dsl', source: 'body.dsl'}};
    const deep = Array.from({length: 17}, (_, index) => checkpoint(`deep-${index}`, index === 16 ? 'output done = input.value' : `use checkpoint "deep-${index + 1}"`));
    const all = [direct, first, second, recovery, ...deep];
    const provider: DslCheckpointProvider = {
        getCheckpoint: (id) => all.find((item) => item.id === id) ?? null,
        getCheckpointResolves: () => ({}),
        getCheckpointBody: (id) => {
            const item = all.find((candidate) => candidate.id === id);
            return item?.body ? {source: item.id === 'recovery' ? 'output ignored = input.value' : item.id.startsWith('deep-') ? (item.id === 'deep-16' ? 'output done = input.value' : `use checkpoint "deep-${Number(item.id.slice(5)) + 1}"`) : item.id === 'direct' ? 'use checkpoint "direct"' : item.id === 'first' ? 'use checkpoint "second"' : 'use checkpoint "first"', stepResolves: {}} : null;
        },
    };
    const run = async (id: string) => await runDsl(normalizeDsl(parseDsl(`use checkpoint "${id}"`)), {
        workspaceName: 'ws-dsl', deps: createDeps([]), checkpointProvider: provider,
    });
    await assert.rejects(() => run('recovery'), (error: unknown) => error instanceof DslRuntimeError && error.code === 'ERR_DSL_CHECKPOINT_NOT_CALLABLE');
    await assert.rejects(() => run('direct'), (error: unknown) => error instanceof DslRuntimeError && error.code === 'ERR_DSL_CHECKPOINT_RECURSION');
    await assert.rejects(() => run('first'), (error: unknown) => error instanceof DslRuntimeError && error.code === 'ERR_DSL_CHECKPOINT_RECURSION');
    await assert.rejects(() => run('deep-0'), (error: unknown) => error instanceof DslRuntimeError && error.code === 'ERR_DSL_CHECKPOINT_DEPTH');
});

test('checkpoint DSL body resolve injection returns Runner validation errors', async () => {
    await assert.rejects(
        () => runCheckpointDslBody({
            checkpoint: {id: 'resolve-body', kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}},
            source: 'use resolves "resolve-body" as target\nclick target.button',
            stepResolves: {button: {}},
            executeStep: async (step) => ({stepId: step.id, ok: true}),
            workspaceName: 'ws-dsl',
            deps: createDeps([]),
        }),
        (error: unknown) => error instanceof DslRuntimeError && error.code === 'ERR_BAD_ARGS',
    );
});

test('checkpoint DSL body injects linked resolves and rejects missing resolve symbols', async () => {
    const calls: StepUnion[] = [];
    await runCheckpointDslBody({
        checkpoint: {id: 'resolve-positive', kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}},
        source: 'use resolves "resolve-positive" as target\nclick target.button',
        stepResolves: {button: {hint: {raw: {selector: '#button'}}}},
        executeStep: async (step) => {calls.push(step); return {stepId: step.id, ok: true};},
        workspaceName: 'ws-dsl', deps: createDeps([]),
    });
    assert.equal((calls[0].args as {resolveId?: string}).resolveId, undefined);
    assert.equal(calls[0].resolve?.hint?.raw?.selector, '#button');
    await assert.rejects(
        () => runCheckpointDslBody({
            checkpoint: {id: 'resolve-missing', kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}},
            source: 'use resolves "resolve-missing" as target\nclick target.button', stepResolves: {},
            executeStep: async (step) => ({stepId: step.id, ok: true}), workspaceName: 'ws-dsl', deps: createDeps([]),
        }),
        (error: unknown) => error instanceof DslValidationError && error.diagnostics.some((item) => item.code === 'ERR_DSL_RESOLVE_SYMBOL_NOT_FOUND'),
    );
});

test('runDsl wraps failed act steps as DslRuntimeError', async () => {
    const deps = createDeps([]);
    deps.pluginHost = {
        getExecutors: () =>
            ({
                'browser.query': async (step: StepUnion) => ({
                    stepId: step.id,
                    ok: true,
                    data: { kind: 'nodeId', nodeId: 'buyer-input' },
                }),
                'browser.fill': async (step: StepUnion) => ({
                    stepId: step.id,
                    ok: false,
                    error: {
                        code: 'ERR_FILL_FAILED',
                        message: 'fill failed',
                        details: {profileName: 'order-page', ruleId: 'buyer'},
                    },
                }),
            }) as any,
    } as any;

    await assert.rejects(
        () =>
            runDsl(
                normalizeDsl(
                    parseDsl(`
                        let buyer = query entity.target "order.form" {
                          kind: "form.field"
                          fieldKey: "buyer"
                        }

                        fill buyer with input.user.name
                    `),
                ),
                {
                    workspaceName: 'ws-dsl',
                    deps,
                    input: { user: { name: 'alice' } },
                },
            ),
        (error: unknown) =>
            error instanceof DslRuntimeError &&
            error.code === 'ERR_FILL_FAILED' &&
            error.message === 'fill failed' &&
            (error.details as {profileName?: string; ruleId?: string}).profileName === 'order-page' &&
            (error.details as {profileName?: string; ruleId?: string}).ruleId === 'buyer',
    );
});
