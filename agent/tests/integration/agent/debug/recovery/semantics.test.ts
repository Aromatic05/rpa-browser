import test from 'node:test';
import assert from 'node:assert/strict';
import type {DslEffectDescriptor, DslFailureDescriptor} from '../../../../../src/automation/dsl/debug/contracts';
import type {DebugEffectRecord} from '../../../../../src/agent/debug/effects/contracts';
import type {WorldViewDescriptor} from '../../../../../src/agent/worldview/contracts';
import {
    classifyFailure,
    aggregateEffectRisk,
    compensatedEffectSequences,
    effectsToUndoSince,
} from '../../../../../src/agent/debug/recovery/semantics';

const world: WorldViewDescriptor = Object.freeze({
    workspaceName: 'ws-recovery',
    tabName: 'main',
    pageUrl: '/orders',
    revision: {pageEpoch: 'epoch-1', captureRevision: 1},
});

const readFailure = (code = 'ERR_NOT_FOUND'): DslFailureDescriptor => Object.freeze({
    kind: 'step',
    stepId: 'step-read',
    stepName: 'browser.query',
    classification: 'read',
    args: {expr: 'table.rowCount'},
    code,
    message: 'no match',
});

const clickFailure = (code = 'ERR_CLICK'): DslFailureDescriptor => Object.freeze({
    kind: 'step',
    stepId: 'step-click',
    stepName: 'browser.click',
    classification: 'effect',
    args: {nodeId: 'submit'},
    code,
    message: 'click failed',
});

const invariantFailure = (): DslFailureDescriptor => Object.freeze({
    kind: 'invariant',
    code: 'ERR_DSL_ENSURE_FAILED',
    message: 'ensure failed',
    details: Object.freeze({expected: true, actual: false, condition: Object.freeze({op: 'eq', args: []})}),
});

const effectRecord = (
    sequence: number,
    reversibility: 'unknown' | 'reversible' | 'compensatable' | 'irreversible',
    options: Partial<DebugEffectRecord> = {},
): DebugEffectRecord => {
    const effect: DslEffectDescriptor = Object.freeze({
        stepId: `step-${sequence}`,
        stepName: 'browser.fill',
        args: {nodeId: 'buyer-input'},
        semantics: Object.freeze({reversibility}),
    });
    return Object.freeze({
        sequence,
        location: Object.freeze({
            programId: 'main',
            path: `body.${sequence - 1}`,
            kind: 'output' as const,
            loops: [],
            callStack: [],
        }),
        effect,
        outcome: Object.freeze({status: 'succeeded'}),
        worldBefore: world,
        worldAfter: world,
        ...options,
    });
};

const compensatedRecord = (sequence: number, compensates: number): DebugEffectRecord => effectRecord(sequence, 'unknown', {
    compensates: {effectSequence: compensates},
    effect: Object.freeze({
        stepId: `comp-${sequence}`,
        stepName: 'browser.fill',
        args: {nodeId: 'buyer-input'},
        semantics: Object.freeze({reversibility: 'unknown'}),
    }),
});

test('classifyFailure distinguishes read, world-effect, and invariant failures', () => {
    assert.equal(classifyFailure(readFailure()), 'read');
    assert.equal(classifyFailure(clickFailure()), 'world_effect');
    assert.equal(classifyFailure(invariantFailure()), 'invariant');
});

test('classifyFailure does not infer reversibility from the browser verb', () => {
    const write: DslFailureDescriptor = Object.freeze({
        kind: 'step',
        stepId: 'step-write',
        stepName: 'browser.goto',
        classification: 'effect',
        args: {url: 'https://example.com'},
        code: 'ERR_NAVIGATION',
        message: 'navigation failed',
    });
    assert.equal(classifyFailure(write), 'world_effect');
});

test('aggregateEffectRisk orders risk from irreversible to reversible', () => {
    assert.equal(aggregateEffectRisk([]), 'none');
    assert.equal(aggregateEffectRisk([effectRecord(1, 'reversible')]), 'reversible');
    assert.equal(
        aggregateEffectRisk([effectRecord(1, 'reversible'), effectRecord(2, 'compensatable')]),
        'compensatable',
    );
    assert.equal(
        aggregateEffectRisk([effectRecord(1, 'compensatable'), effectRecord(2, 'unknown')]),
        'unknown',
    );
    assert.equal(
        aggregateEffectRisk([effectRecord(1, 'reversible'), effectRecord(2, 'irreversible')]),
        'irreversible',
    );
});

test('compensatedEffectSequences collects only succeeded compensations', () => {
    const journal = [
        effectRecord(1, 'reversible'),
        effectRecord(2, 'compensatable'),
        compensatedRecord(3, 1),
        compensatedRecord(4, 2),
        effectRecord(5, 'unknown', {outcome: Object.freeze({
            status: 'failed',
            error: Object.freeze({code: 'ERR_COMPENSATION_EXECUTION', message: 'failed'}),
        }), compensates: {effectSequence: 5}}),
    ];
    assert.deepEqual([...compensatedEffectSequences(journal)].sort(), [1, 2]);
});

test('effectsToUndoSince mirrors the transaction selection: excludes compensations and already-compensated rows', () => {
    const journal = [
        effectRecord(1, 'reversible'),
        effectRecord(2, 'reversible'),
        compensatedRecord(3, 1),
        effectRecord(4, 'unknown'),
    ];
    const undo = effectsToUndoSince(journal, 0);
    assert.deepEqual(undo.map((record) => record.sequence), [2, 4]);
    assert.equal(undo[0].effect.semantics.reversibility, 'reversible');
});

test('effectsToUndoSince is bounded by the anchor effect position', () => {
    const journal = [
        effectRecord(1, 'reversible'),
        effectRecord(2, 'compensatable'),
        effectRecord(3, 'reversible'),
    ];
    const undo = effectsToUndoSince(journal, 1);
    assert.deepEqual(undo.map((record) => record.sequence), [2, 3]);
});