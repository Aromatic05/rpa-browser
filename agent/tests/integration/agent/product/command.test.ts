import test from 'node:test';
import assert from 'node:assert/strict';
import {
    dispatchProductCommand,
    parseProductCommand,
    ProductCommandError,
    type ProductController,
} from '../../../../src/agent/product';

type Stub = {
    product: ProductController;
    calls: Array<{method: string; args: unknown[]}>;
};

const stubProduct = (overrides: Partial<Record<keyof ProductController, unknown>> = {}): Stub => {
    const calls: Array<{method: string; args: unknown[]}> = [];
    const record = (method: string, fallback: unknown) => (...args: unknown[]) => {
        calls.push({method, args});
        const custom = overrides[method as keyof typeof overrides];
        if (typeof custom === 'function') {return (custom as (...a: unknown[]) => unknown)(...args);}
        return fallback;
    };
    const view = {taskId: 'task-1', status: 'running'};
    const product = {
        workspaceView: record('workspaceView', {workspace: 'ws'}),
        startTask: record('startTask', view),
        taskView: record('taskView', view),
        listTasks: record('listTasks', {active: [], history: []}),
        pauseTask: record('pauseTask', view),
        resumeTask: record('resumeTask', view),
        stopTask: record('stopTask', view),
        saveAutomation: record('saveAutomation', {saved: true, name: 'saved'}),
        approveTask: record('approveTask', view),
        denyTask: record('denyTask', view),
        answerTask: record('answerTask', view),
        chooseRecoveryTask: record('chooseRecoveryTask', view),
        beginGuidanceTask: record('beginGuidanceTask', view),
        returnControlTask: record('returnControlTask', view),
        beginAuthoring: record('beginAuthoring', {workspace: 'ws'}),
        endAuthoring: record('endAuthoring', {workspace: 'ws'}),
        librarySummary: record('librarySummary', {automations: [], procedures: [], recoveries: [], demonstrations: [], pageKnowledge: []}),
        events: record('events', {events: [], nextSeq: 0, gap: false}),
    } as unknown as ProductController;
    return {product, calls};
};

const badArgs = (fn: () => unknown): void => {
    assert.throws(fn, (error: unknown) =>
        error instanceof ProductCommandError && error.code === 'ERR_BAD_ARGS');
};

const rejectsCode = (promise: Promise<unknown>, code: string): Promise<void> =>
    assert.rejects(
        () => promise,
        (error: unknown) => error instanceof ProductCommandError && error.code === code,
    );

test('parseProductCommand normalizes every registered verb', () => {
    assert.deepEqual(parseProductCommand({verb: 'workspaceView'}), {verb: 'workspaceView'});
    assert.deepEqual(parseProductCommand({verb: 'listTasks'}), {verb: 'listTasks'});
    assert.deepEqual(parseProductCommand({verb: 'librarySummary'}), {verb: 'librarySummary'});
    assert.deepEqual(parseProductCommand({verb: 'startTask', prompt: '  fill the form  '}), {verb: 'startTask', prompt: 'fill the form'});
    assert.deepEqual(parseProductCommand({verb: 'taskView', taskId: ' t '}), {verb: 'taskView', taskId: 't'});
    assert.deepEqual(parseProductCommand({verb: 'events', taskId: 't'}), {verb: 'events', taskId: 't', afterSeq: 0});
    assert.deepEqual(parseProductCommand({verb: 'pauseTask', taskId: 't'}), {verb: 'pauseTask', taskId: 't'});
    assert.deepEqual(parseProductCommand({verb: 'resumeTask', taskId: 't'}), {verb: 'resumeTask', taskId: 't'});
    assert.deepEqual(parseProductCommand({verb: 'stopTask', taskId: 't'}), {verb: 'stopTask', taskId: 't'});
    assert.deepEqual(parseProductCommand({verb: 'saveAutomation', taskId: 't', name: ' saved '}),
        {verb: 'saveAutomation', taskId: 't', name: 'saved'});
    assert.deepEqual(parseProductCommand({verb: 'approve', taskId: 't', interactionToken: 'tok'}),
        {verb: 'approve', taskId: 't', interactionToken: 'tok'});
    assert.deepEqual(parseProductCommand({verb: 'deny', taskId: 't', interactionToken: 'tok', reason: 'r', requestedAlternative: 'alt'}),
        {verb: 'deny', taskId: 't', interactionToken: 'tok', reason: 'r', requestedAlternative: 'alt'});
    assert.deepEqual(parseProductCommand({verb: 'answer', taskId: 't', interactionToken: 'tok', value: {a: 1}}),
        {verb: 'answer', taskId: 't', interactionToken: 'tok', value: {a: 1}});
    assert.deepEqual(parseProductCommand({verb: 'recovery', taskId: 't', interactionToken: 'tok', optionId: 'o'}),
        {verb: 'recovery', taskId: 't', interactionToken: 'tok', optionId: 'o'});
    assert.deepEqual(parseProductCommand({verb: 'takeover', taskId: 't', interactionToken: 'tok', mode: 'teach'}),
        {verb: 'takeover', taskId: 't', interactionToken: 'tok', mode: 'teach'});
    assert.deepEqual(parseProductCommand({verb: 'returnControl', taskId: 't', interactionToken: 'tok', mode: 'annotate', savedReference: 'procedure:pay'}),
        {verb: 'returnControl', taskId: 't', interactionToken: 'tok', mode: 'annotate', savedReference: 'procedure:pay'});
    assert.deepEqual(parseProductCommand({verb: 'beginAuthoring', activity: 'teach', teachKind: 'recovery'}),
        {verb: 'beginAuthoring', activity: 'teach', teachKind: 'recovery'});
    assert.deepEqual(parseProductCommand({verb: 'beginAuthoring', activity: 'annotate'}),
        {verb: 'beginAuthoring', activity: 'annotate'});
    assert.deepEqual(parseProductCommand({verb: 'endAuthoring', outcome: 'saved'}),
        {verb: 'endAuthoring', outcome: 'saved'});
});

test('parseProductCommand fails closed on malformed verbs and fields', () => {
    badArgs(() => parseProductCommand(null));
    badArgs(() => parseProductCommand('startTask'));
    badArgs(() => parseProductCommand({}));
    badArgs(() => parseProductCommand({verb: ''}));
    badArgs(() => parseProductCommand({verb: 'teleport'}));
    badArgs(() => parseProductCommand({verb: 'startTask'}));
    badArgs(() => parseProductCommand({verb: 'startTask', prompt: '   '}));
    badArgs(() => parseProductCommand({verb: 'taskView', taskId: 7}));
    badArgs(() => parseProductCommand({verb: 'events', taskId: 't', afterSeq: 1.5}));
    badArgs(() => parseProductCommand({verb: 'events', taskId: 't', afterSeq: -1}));
    badArgs(() => parseProductCommand({verb: 'approve', taskId: 't'}));
    badArgs(() => parseProductCommand({verb: 'deny', taskId: 't', interactionToken: 'tok'}));
    badArgs(() => parseProductCommand({verb: 'takeover', taskId: 't', interactionToken: 'tok', mode: 'hover'}));
    badArgs(() => parseProductCommand({verb: 'returnControl', taskId: 't', interactionToken: 'tok', mode: 'manual', savedReference: 42}));
    badArgs(() => parseProductCommand({verb: 'beginAuthoring'}));
    badArgs(() => parseProductCommand({verb: 'beginAuthoring', activity: 'teach'}));
    badArgs(() => parseProductCommand({verb: 'beginAuthoring', activity: 'teach', teachKind: 'checkpoint'}));
    badArgs(() => parseProductCommand({verb: 'beginAuthoring', activity: 'annotate', teachKind: 'procedure'}));
    badArgs(() => parseProductCommand({verb: 'endAuthoring', outcome: 'pending'}));
});

test('startTask carries prompt only and never accepts provider/model', () => {
    badArgs(() => parseProductCommand({verb: 'startTask', prompt: 'go', provider: 'evil'}));
    badArgs(() => parseProductCommand({verb: 'startTask', prompt: 'go', model: 'evil'}));
    badArgs(() => parseProductCommand({verb: 'startTask', prompt: 'go', executionMode: 'react-baseline'}));
});

test('parseProductCommand rejects unknown fields for every verb (additionalProperties false)', () => {
    const payloads: Array<Record<string, unknown>> = [
        {verb: 'workspaceView', sessionId: 'x'},
        {verb: 'workspaceView', runId: 'x'},
        {verb: 'listTasks', internal: true},
        {verb: 'librarySummary', provider: 'p'},
        {verb: 'startTask', prompt: 'go', internal: 1},
        {verb: 'taskView', taskId: 't', sessionId: 'x'},
        {verb: 'events', taskId: 't', afterSeq: 0, runId: 'x'},
        {verb: 'pauseTask', taskId: 't', internal: 1},
        {verb: 'resumeTask', taskId: 't', internal: 1},
        {verb: 'stopTask', taskId: 't', internal: 1},
        {verb: 'saveAutomation', taskId: 't', name: 'x', internal: 1},
        {verb: 'approve', taskId: 't', interactionToken: 'tok', provider: 'p'},
        {verb: 'deny', taskId: 't', interactionToken: 'tok', reason: 'r', model: 'm'},
        {verb: 'answer', taskId: 't', interactionToken: 'tok', value: 1, internal: 'x'},
        {verb: 'recovery', taskId: 't', interactionToken: 'tok', optionId: 'o', runId: 'r'},
        {verb: 'takeover', taskId: 't', interactionToken: 'tok', mode: 'manual', sessionId: 's'},
        {verb: 'returnControl', taskId: 't', interactionToken: 'tok', mode: 'manual', internal: {}},
        {verb: 'beginAuthoring', activity: 'annotate', provider: 'p'},
        {verb: 'beginAuthoring', activity: 'teach', teachKind: 'procedure', runId: 'x'},
        {verb: 'endAuthoring', outcome: 'saved', internal: 'x'},
    ];
    for (const payload of payloads) {
        badArgs(() => parseProductCommand(payload));
    }
});

test('dispatchProductCommand executes nothing when the envelope carries unknown fields', async () => {
    const {product, calls} = stubProduct();
    await rejectsCode(
        dispatchProductCommand(product, {verb: 'startTask', prompt: 'go', model: 'evil'}),
        'ERR_BAD_ARGS',
    );
    await rejectsCode(
        dispatchProductCommand(product, {verb: 'approve', taskId: 't', interactionToken: 'tok', sessionId: 'leak'}),
        'ERR_BAD_ARGS',
    );
    assert.deepEqual(calls, [], 'a rejected envelope must not touch the controller');
});

test('dispatchProductCommand routes each verb to exactly one controller method', async () => {
    const commands: Array<{command: Record<string, unknown>; method: string; args: unknown[]}> = [
        {command: {verb: 'workspaceView'}, method: 'workspaceView', args: []},
        {command: {verb: 'listTasks'}, method: 'listTasks', args: []},
        {command: {verb: 'startTask', prompt: ' go '}, method: 'startTask', args: [{prompt: 'go'}]},
        {command: {verb: 'taskView', taskId: 't'}, method: 'taskView', args: ['t']},
        {command: {verb: 'events', taskId: 't', afterSeq: 4}, method: 'events', args: ['t', 4]},
        {command: {verb: 'pauseTask', taskId: 't'}, method: 'pauseTask', args: [{taskId: 't'}]},
        {command: {verb: 'resumeTask', taskId: 't'}, method: 'resumeTask', args: [{taskId: 't'}]},
        {command: {verb: 'stopTask', taskId: 't'}, method: 'stopTask', args: [{taskId: 't'}]},
        {command: {verb: 'saveAutomation', taskId: 't', name: 'saved'}, method: 'saveAutomation', args: [{taskId: 't', name: 'saved'}]},
        {command: {verb: 'approve', taskId: 't', interactionToken: 'tok'}, method: 'approveTask', args: [{taskId: 't', interactionToken: 'tok'}]},
        {command: {verb: 'deny', taskId: 't', interactionToken: 'tok', reason: 'r'}, method: 'denyTask', args: [{taskId: 't', interactionToken: 'tok', reason: 'r'}]},
        {command: {verb: 'answer', taskId: 't', interactionToken: 'tok', value: 5}, method: 'answerTask', args: [{taskId: 't', interactionToken: 'tok', value: 5}]},
        {command: {verb: 'recovery', taskId: 't', interactionToken: 'tok', optionId: 'o'}, method: 'chooseRecoveryTask', args: [{taskId: 't', interactionToken: 'tok', optionId: 'o'}]},
        {command: {verb: 'takeover', taskId: 't', interactionToken: 'tok', mode: 'manual'}, method: 'beginGuidanceTask', args: [{taskId: 't', interactionToken: 'tok', mode: 'manual'}]},
        {command: {verb: 'returnControl', taskId: 't', interactionToken: 'tok', mode: 'teach', savedReference: 'procedure:x'}, method: 'returnControlTask', args: [{taskId: 't', interactionToken: 'tok', mode: 'teach', savedReference: 'procedure:x'}]},
        {command: {verb: 'beginAuthoring', activity: 'annotate'}, method: 'beginAuthoring', args: [{activity: 'annotate'}]},
        {command: {verb: 'endAuthoring', outcome: 'discarded'}, method: 'endAuthoring', args: [{outcome: 'discarded'}]},
        {command: {verb: 'librarySummary'}, method: 'librarySummary', args: []},
    ];
    for (const entry of commands) {
        const {product, calls} = stubProduct();
        await dispatchProductCommand(product, entry.command);
        assert.deepEqual(calls, [{method: entry.method, args: entry.args}],
            `${entry.command.verb} dispatches exactly one ${entry.method} call`);
    }
});

test('dispatchProductCommand maps missing task/interaction results to ERR_NOT_FOUND', async () => {
    const missing = stubProduct({taskView: () => null});
    await rejectsCode(dispatchProductCommand(missing.product, {verb: 'taskView', taskId: 'gone'}), 'ERR_NOT_FOUND');
    const staleDecision = stubProduct({approveTask: () => Promise.resolve(null)});
    await rejectsCode(
        dispatchProductCommand(staleDecision.product, {verb: 'approve', taskId: 'gone', interactionToken: 'tok'}),
        'ERR_NOT_FOUND',
    );
    const noLibrary = stubProduct({librarySummary: () => Promise.resolve(null)});
    await rejectsCode(dispatchProductCommand(noLibrary.product, {verb: 'librarySummary'}), 'ERR_NOT_FOUND');
});

test('dispatchProductCommand preserves controller product errors unchanged', async () => {
    const {product} = stubProduct({
        approveTask: () => Promise.reject(new ProductCommandError('ERR_STALE', 'interaction token is stale')),
    });
    await rejectsCode(
        dispatchProductCommand(product, {verb: 'approve', taskId: 't', interactionToken: 'stale-token'}),
        'ERR_STALE',
    );
    const conflict = stubProduct({
        beginAuthoring: () => {throw new ProductCommandError('ERR_ACTIVITY_CONFLICT', 'workspace owned');},
    });
    await rejectsCode(
        dispatchProductCommand(conflict.product, {verb: 'beginAuthoring', activity: 'annotate'}),
        'ERR_ACTIVITY_CONFLICT',
    );
});
