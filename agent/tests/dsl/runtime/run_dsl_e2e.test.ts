import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDslSource } from '../../../src/dsl/runtime';
import type { DslCheckpointProvider } from '../../../src/dsl/emit';
import type { Checkpoint } from '../../../src/runner/checkpoint';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';

type StubCall = {
    name: string;
    args: Record<string, unknown>;
};

const fixturePath = path.resolve(process.cwd(), 'tests/dsl/fixtures/order_flow.dsl');

const createDeps = (calls: StubCall[]): RunStepsDeps =>
    ({
        runtime: {
            ensureActivePage: async () => ({
                workspaceId: 'ws-dsl-e2e',
                tabId: 'tab-dsl-e2e',
                tabToken: 'tk-dsl-e2e',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return {
                            stepId: step.id,
                            ok: true,
                            data: { kind: 'nodeId', nodeId: 'buyer-input' },
                        };
                    },
                    'browser.fill': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return {
                            stepId: step.id,
                            ok: true,
                            data: { filled: true },
                        };
                    },
                }) as any,
        } as any,
    }) as RunStepsDeps;

test('runDslSource executes the order flow fixture end to end', async () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const calls: StubCall[] = [];
    const checkpoint: Checkpoint = {
        id: 'ensure_logged_in',
        output: {
            loginState: { ref: 'input.username' },
        },
    };
    const checkpointProvider: DslCheckpointProvider = {
        getCheckpoint: (id) => (id === checkpoint.id ? checkpoint : null),
    };

    const result = await runDslSource(source, {
        workspaceId: 'ws-dsl-e2e',
        deps: createDeps(calls),
        checkpointProvider,
        input: {
            username: 'root',
            users: [
                { name: 'alice', enabled: true },
                { name: 'bob', enabled: false },
                { name: 'cara', enabled: true },
            ],
        },
    });

    const queryCalls = calls.filter((item) => item.name === 'browser.query');
    const fillCalls = calls.filter((item) => item.name === 'browser.fill');

    assert.equal(queryCalls.length, 1);
    assert.equal(fillCalls.length, 2);
    assert.deepEqual(
        fillCalls.map((item) => item.args.value),
        ['alice', 'cara'],
    );
    assert.deepEqual(result.scope.output, {
        loginState: 'root',
    });
});
