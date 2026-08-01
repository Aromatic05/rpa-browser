import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRunnerControl} from '../../../src/runner/control';
import {setRunStepsDeps} from '../../../src/runner/run_steps';
import type {StepResult, StepUnion} from '../../../src/runner/steps/types';
import type {Action} from '../../../src/actions/action_protocol';
import {ActionError, ERROR_CODES} from '../../../src/actions/results';
import {getRunnerConfig} from '../../../src/config';
import {completeRunStepsDeps} from '../../helpers/run_steps_workspace';

const action = (type: string, payload: Record<string, unknown>): Action => ({
    v: 1,
    id: `${type}-${Math.random()}`,
    type,
    workspaceName: 'ws-1',
    payload,
    at: Date.now(),
});

test('task.run.start rejects an active duplicate run id', async () => {
    const baseConfig = getRunnerConfig();
    const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
    setRunStepsDeps(deps);
    const control = createRunnerControl({
        runnerConfig: {
            ...baseConfig,
            checkpointPolicy: {...baseConfig.checkpointPolicy, enabled: false},
        },
    });
    const workspace = deps.resolveWorkspace('ws-1');
    const workspaceRegistry = {} as never;
    const runId = 'duplicate-active-run';

    await control.handle({
        action: action('task.run.start', {runId}),
        workspace,
        workspaceRegistry,
    });
    await assert.rejects(
        () => control.handle({
            action: action('task.run.start', {runId}),
            workspace,
            workspaceRegistry,
        }),
        (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_CONFLICT,
    );

    await control.handle({
        action: action('task.run.halt', {runId}),
        workspace,
        workspaceRegistry,
    });
});

test('task.run.poll retains terminal results until the client drains them', async () => {
    let executed = false;
    const baseConfig = getRunnerConfig();
    const deps = completeRunStepsDeps({
        pluginHost: {
            getExecutors: () => ({
                'browser.click': async (step: StepUnion) => {
                    executed = true;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            }),
        } as never,
    }, {workspaceName: 'ws-1'});
    setRunStepsDeps(deps);
    const control = createRunnerControl({
        runnerConfig: {
            ...baseConfig,
            checkpointPolicy: {...baseConfig.checkpointPolicy, enabled: false},
        },
    });
    const workspace = deps.resolveWorkspace('ws-1');
    const workspaceRegistry = {} as never;
    const runId = 'terminal-result-retention';

    await control.handle({
        action: action('task.run.start', {runId}),
        workspace,
        workspaceRegistry,
    });
    await control.handle({
        action: action('task.run.push', {
            runId,
            steps: [{id: 'click-once', name: 'browser.click', args: {nodeId: 'button'}}],
            close: true,
        }),
        workspace,
        workspaceRegistry,
    });
    for (let attempt = 0; attempt < 50 && !executed; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));

    await assert.rejects(
        () => control.handle({
            action: action('task.run.push', {runId, steps: {id: 'invalid'}}),
            workspace,
            workspaceRegistry,
        }),
        (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_ARGS,
    );
    await assert.rejects(
        () => control.handle({
            action: action('task.run.push', {
                runId,
                steps: [{id: 'late-click', name: 'browser.click', args: {nodeId: 'late'}}],
            }),
            workspace,
            workspaceRegistry,
        }),
        (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
    );
    for (const type of ['task.run.halt', 'task.run.suspend', 'task.run.continue', 'task.run.flush']) {
        await assert.rejects(
            () => control.handle({
                action: action(type, {runId}),
                workspace,
                workspaceRegistry,
            }),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
        );
    }

    await assert.rejects(
        () => control.handle({
            action: action('task.run.poll', {runId, cursor: 2}),
            workspace,
            workspaceRegistry,
        }),
        (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_ARGS,
    );

    const polled = await control.handle({
        action: action('task.run.poll', {runId, cursor: 0}),
        workspace,
        workspaceRegistry,
    });
    const payload = polled.reply.payload as {items: StepResult[]; done: boolean; cursor: number};
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].ok, true);
    assert.equal(payload.done, true);
    assert.equal(payload.cursor, 1);
});

test('task.run.start rejects malformed checkpoint assets before registering the run', async () => {
    const baseConfig = getRunnerConfig();
    const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
    setRunStepsDeps(deps);
    const control = createRunnerControl({
        runnerConfig: {
            ...baseConfig,
            checkpointPolicy: {...baseConfig.checkpointPolicy, enabled: false},
        },
    });
    const workspace = deps.resolveWorkspace('ws-1');
    const workspaceRegistry = {} as never;
    const invalidPayloads = [
        {checkpoints: {}},
        {checkpoints: [{id: 'invalid-recovery', kind: 'recovery', trigger: {matchRules: []}}]},
        {stepResolves: []},
        {checkpointStepResolves: {repair: []}},
        {checkpointBodies: {repair: 42}},
    ];

    for (const [index, invalid] of invalidPayloads.entries()) {
        const runId = `invalid-assets-${index}`;
        await assert.rejects(
            () => control.handle({
                action: action('task.run.start', {runId, ...invalid}),
                workspace,
                workspaceRegistry,
            }),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_ARGS,
        );
        await control.handle({
            action: action('task.run.start', {runId}),
            workspace,
            workspaceRegistry,
        });
        await control.handle({
            action: action('task.run.halt', {runId}),
            workspace,
            workspaceRegistry,
        });
    }
});

test('task.run.start rolls back runtime identity when checkpoint persistence fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-run-start-'));
    const checkpointPath = path.join(root, 'checkpoint-store');
    fs.mkdirSync(checkpointPath);
    try {
        const baseConfig = getRunnerConfig();
        const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
        setRunStepsDeps(deps);
        const control = createRunnerControl({
            runnerConfig: {
                ...baseConfig,
                checkpointPolicy: {
                    ...baseConfig.checkpointPolicy,
                    enabled: true,
                    filePath: checkpointPath,
                    flushIntervalMs: 60_000,
                },
            },
        });
        const workspace = deps.resolveWorkspace('ws-1');
        const workspaceRegistry = {} as never;
        const runId = 'persist-failed-start';

        await assert.rejects(() => control.handle({
            action: action('task.run.start', {runId}),
            workspace,
            workspaceRegistry,
        }));

        fs.rmSync(checkpointPath, {recursive: true});
        await control.handle({
            action: action('task.run.start', {runId}),
            workspace,
            workspaceRegistry,
        });
        await control.handle({
            action: action('task.run.halt', {runId}),
            workspace,
            workspaceRegistry,
        });
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('completed persisted runs cannot be restarted or resumed with the same identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-run-terminal-'));
    const checkpointPath = path.join(root, 'checkpoints.json');
    let executions = 0;
    try {
        const baseConfig = getRunnerConfig();
        const deps = completeRunStepsDeps({
            pluginHost: {
                getExecutors: () => ({
                    'browser.click': async (step: StepUnion) => {
                        executions += 1;
                        return {stepId: step.id, ok: true};
                    },
                }),
            } as never,
        }, {workspaceName: 'ws-1'});
        setRunStepsDeps(deps);
        const control = createRunnerControl({
            runnerConfig: {
                ...baseConfig,
                checkpointPolicy: {
                    ...baseConfig.checkpointPolicy,
                    enabled: true,
                    filePath: checkpointPath,
                    flushIntervalMs: 60_000,
                },
            },
        });
        const workspace = deps.resolveWorkspace('ws-1');
        const workspaceRegistry = {} as never;
        const runId = 'terminal-run-id';
        const steps = [{id: 'click-once', name: 'browser.click', args: {nodeId: 'button'}}];

        await control.handle({action: action('task.run.start', {runId}), workspace, workspaceRegistry});
        await control.handle({
            action: action('task.run.push', {runId, steps, close: true}),
            workspace,
            workspaceRegistry,
        });
        for (let attempt = 0; attempt < 50 && executions < 1; attempt += 1) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        const poll = await control.handle({
            action: action('task.run.poll', {runId, cursor: 0}),
            workspace,
            workspaceRegistry,
        });
        assert.equal((poll.reply.payload as {done: boolean}).done, true);

        await assert.rejects(
            () => control.handle({action: action('task.run.start', {runId}), workspace, workspaceRegistry}),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_CONFLICT,
        );
        await assert.rejects(
            () => control.handle({
                action: action('task.run.resume', {runId, steps, close: true}),
                workspace,
                workspaceRegistry,
            }),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
        );
        assert.equal(executions, 1);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('task.run.halt keeps the run active when terminal checkpoint persistence fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-run-halt-'));
    const checkpointPath = path.join(root, 'checkpoints.json');
    try {
        const baseConfig = getRunnerConfig();
        const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
        setRunStepsDeps(deps);
        const control = createRunnerControl({
            runnerConfig: {
                ...baseConfig,
                checkpointPolicy: {
                    ...baseConfig.checkpointPolicy,
                    enabled: true,
                    filePath: checkpointPath,
                    flushIntervalMs: 60_000,
                },
            },
        });
        const workspace = deps.resolveWorkspace('ws-1');
        const workspaceRegistry = {} as never;
        const runId = 'halt-persist-failure';

        await control.handle({action: action('task.run.start', {runId}), workspace, workspaceRegistry});
        fs.rmSync(checkpointPath);
        fs.mkdirSync(checkpointPath);

        await assert.rejects(() => control.handle({
            action: action('task.run.halt', {runId}),
            workspace,
            workspaceRegistry,
        }));

        fs.rmSync(checkpointPath, {recursive: true});
        const halted = await control.handle({
            action: action('task.run.halt', {runId}),
            workspace,
            workspaceRegistry,
        });
        assert.equal(
            (halted.reply.payload as {checkpoint: {status: string}}).checkpoint.status,
            'halted',
        );
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('task run controls enforce workspace ownership for active and persisted runs', async () => {
    const baseConfig = getRunnerConfig();
    const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
    setRunStepsDeps(deps);
    const workspace = deps.resolveWorkspace('ws-1');
    const otherWorkspace = {...workspace, name: 'ws-2'} as typeof workspace;
    const workspaceRegistry = {} as never;
    const activeControl = createRunnerControl({
        runnerConfig: {
            ...baseConfig,
            checkpointPolicy: {...baseConfig.checkpointPolicy, enabled: false},
        },
    });
    const activeRunId = 'workspace-owned-active-run';
    await activeControl.handle({
        action: action('task.run.start', {runId: activeRunId}),
        workspace,
        workspaceRegistry,
    });

    for (const request of [
        action('task.run.push', {runId: activeRunId, steps: []}),
        action('task.run.poll', {runId: activeRunId, cursor: 0}),
        action('task.run.halt', {runId: activeRunId}),
    ]) {
        await assert.rejects(
            () => activeControl.handle({action: request, workspace: otherWorkspace, workspaceRegistry}),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_CONFLICT,
        );
    }
    await activeControl.handle({
        action: action('task.run.halt', {runId: activeRunId}),
        workspace,
        workspaceRegistry,
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-run-workspace-owner-'));
    const checkpointPath = path.join(root, 'checkpoints.json');
    try {
        const persistedRunId = 'workspace-owned-persisted-run';
        fs.writeFileSync(checkpointPath, JSON.stringify({
            version: 1,
            savedAt: Date.now(),
            checkpoints: {
                [persistedRunId]: {
                    runId: persistedRunId,
                    workspaceName: 'ws-1',
                    status: 'running',
                    cursor: 0,
                    nextSeq: 0,
                    lastAckSeq: -1,
                    updatedAt: Date.now(),
                },
            },
        }), 'utf8');
        const persistedControl = createRunnerControl({
            runnerConfig: {
                ...baseConfig,
                checkpointPolicy: {
                    ...baseConfig.checkpointPolicy,
                    enabled: true,
                    filePath: checkpointPath,
                    flushIntervalMs: 60_000,
                },
            },
        });
        await assert.rejects(
            () => persistedControl.handle({
                action: action('task.run.resume', {runId: persistedRunId, steps: []}),
                workspace: otherWorkspace,
                workspaceRegistry,
            }),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_CONFLICT,
        );
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('suspend and continue signals publish observable runner state transitions', async () => {
    const baseConfig = getRunnerConfig();
    const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
    setRunStepsDeps(deps);
    const control = createRunnerControl({
        runnerConfig: {
            ...baseConfig,
            checkpointPolicy: {...baseConfig.checkpointPolicy, enabled: false},
        },
    });
    const workspace = deps.resolveWorkspace('ws-1');
    const workspaceRegistry = {} as never;
    const runId = 'observable-suspend-run';
    await control.handle({action: action('task.run.start', {runId}), workspace, workspaceRegistry});

    await control.handle({action: action('task.run.suspend', {runId}), workspace, workspaceRegistry});
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    const suspended = await control.handle({
        action: action('task.run.checkpoint', {runId}),
        workspace,
        workspaceRegistry,
    });
    assert.equal(
        (suspended.reply.payload as {checkpoint: {status: string}}).checkpoint.status,
        'suspended',
    );

    await control.handle({action: action('task.run.continue', {runId}), workspace, workspaceRegistry});
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    const running = await control.handle({
        action: action('task.run.checkpoint', {runId}),
        workspace,
        workspaceRegistry,
    });
    assert.equal(
        (running.reply.payload as {checkpoint: {status: string}}).checkpoint.status,
        'running',
    );

    await control.handle({action: action('task.run.halt', {runId}), workspace, workspaceRegistry});
});

test('task run identifiers reject malformed external values before registration', async () => {
    const baseConfig = getRunnerConfig();
    const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
    setRunStepsDeps(deps);
    const control = createRunnerControl({
        runnerConfig: {
            ...baseConfig,
            checkpointPolicy: {...baseConfig.checkpointPolicy, enabled: false},
        },
    });
    const workspace = deps.resolveWorkspace('ws-1');
    const workspaceRegistry = {} as never;
    for (const runId of ['', '   ', ' padded ', 42, 'r'.repeat(129)]) {
        await assert.rejects(
            () => control.handle({
                action: action('task.run.start', {runId}),
                workspace,
                workspaceRegistry,
            }),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_ARGS,
        );
    }

    await control.handle({
        action: action('task.run.start', {runId: 'valid-run-id'}),
        workspace,
        workspaceRegistry,
    });
    await control.handle({
        action: action('task.run.halt', {runId: 'valid-run-id'}),
        workspace,
        workspaceRegistry,
    });
});

test('closed resume requires enough step history to reach the persisted cursor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-run-resume-cursor-'));
    const checkpointPath = path.join(root, 'checkpoints.json');
    const runId = 'resume-cursor-run';
    try {
        fs.writeFileSync(checkpointPath, JSON.stringify({
            version: 1,
            savedAt: Date.now(),
            checkpoints: {
                [runId]: {
                    runId,
                    workspaceName: 'ws-1',
                    status: 'running',
                    cursor: 2,
                    nextSeq: 2,
                    lastAckSeq: 1,
                    updatedAt: Date.now(),
                },
            },
        }), 'utf8');
        const baseConfig = getRunnerConfig();
        const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
        setRunStepsDeps(deps);
        const control = createRunnerControl({
            runnerConfig: {
                ...baseConfig,
                checkpointPolicy: {
                    ...baseConfig.checkpointPolicy,
                    enabled: true,
                    filePath: checkpointPath,
                    flushIntervalMs: 60_000,
                },
            },
        });
        const workspace = deps.resolveWorkspace('ws-1');
        const workspaceRegistry = {} as never;

        await assert.rejects(
            () => control.handle({
                action: action('task.run.resume', {runId, steps: [], close: true}),
                workspace,
                workspaceRegistry,
            }),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_ARGS,
        );

        await control.handle({
            action: action('task.run.resume', {runId, steps: [], close: false}),
            workspace,
            workspaceRegistry,
        });
        await control.handle({
            action: action('task.run.halt', {runId}),
            workspace,
            workspaceRegistry,
        });
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('runner control stop waits until active runs persist a halted terminal state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-run-stop-terminal-'));
    const checkpointPath = path.join(root, 'checkpoints.json');
    const runId = 'stop-terminal-run';
    try {
        const baseConfig = getRunnerConfig();
        const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
        setRunStepsDeps(deps);
        const control = createRunnerControl({
            runnerConfig: {
                ...baseConfig,
                checkpointPolicy: {
                    ...baseConfig.checkpointPolicy,
                    enabled: true,
                    filePath: checkpointPath,
                    flushIntervalMs: 60_000,
                },
            },
        });
        const workspace = deps.resolveWorkspace('ws-1');
        const workspaceRegistry = {} as never;

        await control.handle({action: action('task.run.start', {runId}), workspace, workspaceRegistry});
        await control.handle({action: action('task.run.suspend', {runId}), workspace, workspaceRegistry});
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const state = await control.handle({
                action: action('task.run.checkpoint', {runId}),
                workspace,
                workspaceRegistry,
            });
            if ((state.reply.payload as {checkpoint: {status: string}}).checkpoint.status === 'suspended') {break;}
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        await control.stop();

        const persisted = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as {
            checkpoints: Record<string, {status: string}>;
        };
        assert.equal(persisted.checkpoints[runId].status, 'halted');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('runner control stop leaves active runs untouched when terminal persistence fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-run-stop-rollback-'));
    const checkpointPath = path.join(root, 'checkpoints.json');
    const runId = 'stop-rollback-run';
    try {
        const baseConfig = getRunnerConfig();
        const deps = completeRunStepsDeps({}, {workspaceName: 'ws-1'});
        setRunStepsDeps(deps);
        const control = createRunnerControl({
            runnerConfig: {
                ...baseConfig,
                checkpointPolicy: {
                    ...baseConfig.checkpointPolicy,
                    enabled: true,
                    filePath: checkpointPath,
                    flushIntervalMs: 60_000,
                },
            },
        });
        const workspace = deps.resolveWorkspace('ws-1');
        const workspaceRegistry = {} as never;

        await control.handle({action: action('task.run.start', {runId}), workspace, workspaceRegistry});
        fs.rmSync(checkpointPath);
        fs.mkdirSync(checkpointPath);

        await assert.rejects(() => control.stop());

        fs.rmSync(checkpointPath, {recursive: true});
        const pushed = await control.handle({
            action: action('task.run.push', {runId, steps: []}),
            workspace,
            workspaceRegistry,
        });
        assert.equal((pushed.reply.payload as {runId: string}).runId, runId);

        await control.stop();
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});
