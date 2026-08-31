import test from 'node:test';
import assert from 'node:assert/strict';
import {
    deriveTitle,
    interactionWaitingKind,
    sanitizeWorkspaceView,
    validateClarificationValue,
} from '../model/projection.js';
import type { ClarificationSchema, InteractionRequest } from '../model/contracts.js';

test('deriveTitle takes the first non-empty line and truncates to 64 chars with an ellipsis', () => {
    assert.equal(deriveTitle(''), '');
    assert.equal(deriveTitle('  \nFill the order form\nand submit'), 'Fill the order form');
    const long = 'a'.repeat(70);
    const derived = deriveTitle(long);
    assert.equal(derived.length, 65);
    assert.equal(derived.slice(-1), '…');
    assert.equal(derived.slice(0, 64), 'a'.repeat(64));
});

test('sanitizeWorkspaceView drops an unknown interaction kind instead of fabricating a card', () => {
    const raw = {
        workspace: 'ws-1',
        reservation: 'task',
        connection: 'connected',
        activeTask: {
            taskId: 'task-1',
            status: 'waiting_for_user',
            title: 'Place order',
            interaction: { kind: 'future-kind', interactionToken: 'tok', raw: 'secret' },
        },
    };
    const view = sanitizeWorkspaceView(raw);
    const task = view.activeTask;
    assert.ok(task, 'task preserved');
    assert.equal(task.status, 'waiting_for_user');
    assert.equal(task.interaction, undefined, 'unknown interaction kind is dropped');
    assert.equal(interactionWaitingKind(view), null);
    assert.equal(task.timeline.length, 0);
});

test('sanitizeWorkspaceView never passes an unknown phase through (truthfulness)', () => {
    const raw = {
        workspace: 'ws-1',
        reservation: 'task',
        activeTask: {
            taskId: 'task-1',
            status: 'running',
            phase: 'hallucinated',
            title: 'Place order',
        },
    };
    const view = sanitizeWorkspaceView(raw);
    const task = view.activeTask;
    assert.ok(task);
    assert.equal(task.phase, undefined);
});

test('sanitizeWorkspaceView strips raw ids and keeps only known recovery option kinds', () => {
    const raw = {
        workspace: 'ws-1',
        reservation: 'task',
        activeTask: {
            taskId: 'task-1',
            status: 'waiting_for_user',
            title: 'Place order',
            sessionId: 'session-secret',
            interaction: {
                kind: 'recovery_decision',
                interactionToken: 'tok',
                failureSummary: 'could not verify',
                options: [
                    { id: 'a', kind: 'retry', label: 'Retry', eligible: true },
                    { id: 'b', kind: 'recompute', label: 'Recompute', eligible: true },
                    { id: 'c', kind: 'abort', label: 'Abort', eligible: true },
                    { id: 'd', kind: 'terminate', label: 'End task as failed', eligible: true },
                ],
            },
        },
    };
    const view = sanitizeWorkspaceView(raw);
    const options = view.activeTask?.interaction;
    assert.ok(options);
    const decision = options as Extract<InteractionRequest, { kind: 'recovery_decision' }>;
    const kinds = decision.options.map((option) => option.kind);
    assert.deepEqual(kinds, ['retry', 'terminate']);
    assert.equal(JSON.stringify(kinds).includes('recompute'), false);
    assert.equal(JSON.stringify(kinds).includes('abort'), false);
    assert.equal(JSON.stringify(view).includes('sessionId'), false, 'raw ids never survive sanitization');
    assert.equal(JSON.stringify(view).includes('session-secret'), false);
});

test('sanitizeWorkspaceView sanitizes library metadata and drops malformed assets', () => {
    const raw = {
        workspace: 'ws-1',
        reservation: 'idle',
        librarySummary: {
            automations: [{ name: 'Submit report', description: 'Sends the report.', status: 'active' }, { description: 'missing name' }],
            procedures: [{ name: 'Ensure login' }],
            recoveries: [{ name: 'Renew session' }],
            demonstrations: [{ name: 'Onboarding', stepCount: 12 }, { name: 'broken', stepCount: 'x' }],
            pageKnowledge: [{ profileName: 'orders', label: 'Orders page', pageKind: 'form', entityCount: 1 }],
        },
    };
    const view = sanitizeWorkspaceView(raw);
    assert.equal(view.librarySummary.automations.length, 1, 'assets without a name are dropped');
    assert.deepEqual(
        view.librarySummary.demonstrations.map((demo) => demo.stepCount),
        [12, 0],
        'invalid numeric metadata normalizes instead of fabricating',
    );
    assert.equal(view.librarySummary.pageKnowledge[0]?.profileName, 'orders');
});

test('clarification validation enforces the bounded schema', () => {
    const schema: ClarificationSchema = { field: 'qty', type: 'number', min: 1, max: 5 };
    assert.equal(validateClarificationValue('0', schema), 'Must be at least 1.');
    assert.equal(validateClarificationValue('9', schema), 'Must be at most 5.');
    assert.equal(validateClarificationValue('not-a-number', schema), 'Enter a number.');
    assert.equal(validateClarificationValue('3', schema), null);

    const selectSchema: ClarificationSchema = {
        field: 'mode',
        type: 'select',
        allowed: [
            { value: 'fast', label: 'Fast' },
            { value: 'safe', label: 'Safe' },
        ],
    };
    assert.equal(validateClarificationValue('nope', selectSchema), 'Choose one of the allowed options.');
    assert.equal(validateClarificationValue('safe', selectSchema), null);
});