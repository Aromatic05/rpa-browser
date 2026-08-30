import test from 'node:test';
import assert from 'node:assert/strict';
import {
    proveTransactionLocalWorldLineage,
    worldConflictStepResult,
} from '../../../../../src/agent/debug/effects/lineage';
import type {DebugEffectRecord} from '../../../../../src/agent/debug/effects/contracts';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import type {StepUnion} from '../../../../../src/automation/runner/steps/types';
import type {DslStatementLocation} from '../../../../../src/automation/dsl/debug/contracts';

const location: DslStatementLocation = Object.freeze({
    programId: 'main',
    path: 'body.0',
    kind: 'act',
    loops: Object.freeze([]),
    callStack: Object.freeze([]),
});

const view = (pageEpoch: string, captureRevision: number): WorldView => Object.freeze({
    workspaceName: 'ws-cas',
    tabName: 'main',
    pageUrl: '/orders',
    revision: Object.freeze({pageEpoch, captureRevision}),
    entry: undefined as never,
});

const descriptor = (pageEpoch: string, captureRevision: number) => Object.freeze({
    workspaceName: 'ws-cas',
    tabName: 'main',
    pageUrl: '/orders',
    revision: Object.freeze({pageEpoch, captureRevision}),
});

const record = (sequence: number, beforeRev: number, afterRev: number, options: {
    outcome?: 'succeeded' | 'failed';
    compensates?: number;
} = {}): DebugEffectRecord => Object.freeze({
    sequence,
    location,
    effect: Object.freeze({
        stepId: `step-${sequence}`,
        stepName: 'browser.fill',
        args: Object.freeze({nodeId: 'buyer'}),
        semantics: Object.freeze({reversibility: 'unknown' as const}),
    }),
    outcome: options.outcome === 'failed'
        ? Object.freeze({status: 'failed' as const, error: Object.freeze({code: 'ERR_STEP', message: 'failed'})})
        : Object.freeze({status: 'succeeded' as const}),
    worldBefore: descriptor('epoch-a', beforeRev),
    worldAfter: descriptor('epoch-a', afterRev),
    ...(options.compensates !== undefined ? {compensates: Object.freeze({effectSequence: options.compensates})} : {}),
});

test('lineage: an exact expected-world match is allowed without journal consultation', () => {
    const verification = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 2},
        view('epoch-a', 2),
        [record(1, 1, 2)],
    );
    assert.deepEqual(verification, {ok: true, proven: {pageEpoch: 'epoch-a', captureRevision: 2}});
});

test('lineage: a pageEpoch change between effects refuses even a proven revision chain', () => {
    const verification = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 1},
        view('epoch-b', 3),
        [record(1, 1, 2)],
    );
    assert.deepEqual(verification, {ok: false, reason: 'page_epoch_changed'});
});

test('lineage: a world revision behind the expected target refuses a stale forward precondition', () => {
    const verification = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 2},
        view('epoch-a', 1),
        [record(1, 1, 2)],
    );
    assert.deepEqual(verification, {ok: false, reason: 'revision_moved_backward'});
});

test('lineage: consecutive retained self-writes prove the exact worldAfter chain', () => {
    const verification = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 1},
        view('epoch-a', 3),
        [record(1, 1, 2), record(2, 2, 3)],
    );
    assert.deepEqual(verification, {ok: true, proven: {pageEpoch: 'epoch-a', captureRevision: 3}});
});

test('lineage: an expected revision mid-chain advances only across the retained self-writes after it', () => {
    const verification = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 2},
        view('epoch-a', 3),
        [record(1, 1, 2), record(2, 2, 3)],
    );
    assert.deepEqual(verification, {ok: true, proven: {pageEpoch: 'epoch-a', captureRevision: 3}});
});

test('lineage: a world beyond the proven worldAfter chain is refused as unproven', () => {
    const verification = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 1},
        view('epoch-a', 4),
        [record(1, 1, 2), record(2, 2, 3)],
    );
    assert.deepEqual(verification, {ok: false, reason: 'unproven'});
});

test('lineage: an external mutation gap breaks the worldAfter chain and refuses the effect', () => {
    const gapRecord = record(2, 4, 5);
    const verification = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 1},
        view('epoch-a', 3),
        [record(1, 1, 2), gapRecord],
    );
    assert.deepEqual(verification, {ok: false, reason: 'unproven'});
});

test('lineage: a failed effect never advances the worldAfter chain', () => {
    const verification = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 1},
        view('epoch-a', 2),
        [record(1, 1, 2, {outcome: 'failed'})],
    );
    assert.deepEqual(verification, {ok: false, reason: 'unproven'});
});

test('lineage: compensated effects are excluded from the self-write chain', () => {
    const original = record(1, 1, 2);
    const compensation = record(2, 2, 1, {compensates: 1});
    const staleForward = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 1},
        view('epoch-a', 2),
        [original, compensation],
    );
    assert.deepEqual(staleForward, {ok: false, reason: 'unproven'},
        'a compensated forward worldAfter must not be reapproved as a self-write');
    const restoredExact = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 1},
        view('epoch-a', 1),
        [original, compensation],
    );
    assert.deepEqual(restoredExact, {ok: true, proven: {pageEpoch: 'epoch-a', captureRevision: 1}},
        'the restored savepoint world still matches its own expected revision exactly');
    const staleBackward = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 2},
        view('epoch-a', 1),
        [original, compensation],
    );
    assert.deepEqual(staleBackward, {ok: false, reason: 'revision_moved_backward'},
        'a stale forward precondition after compensation must refuse the mutation');
});

test('lineage: a navigation self-write cannot advance the same pageEpoch chain', () => {
    const navigation = Object.freeze({
        ...record(1, 1, 1),
        worldAfter: Object.freeze({
            workspaceName: 'ws-cas',
            tabName: 'main',
            pageUrl: '/other',
            revision: Object.freeze({pageEpoch: 'epoch-b', captureRevision: 1}),
        }),
    });
    const verification = proveTransactionLocalWorldLineage(
        {pageEpoch: 'epoch-a', captureRevision: 1},
        view('epoch-b', 1),
        [navigation],
    );
    assert.deepEqual(verification, {ok: false, reason: 'page_epoch_changed'});
});

test('worldConflictStepResult carries the expected and actual revisions without leaking step args', () => {
    const step = {id: 's1', name: 'browser.fill', args: {nodeId: 'buyer', value: 'SECRET'}} as unknown as StepUnion;
    const result = worldConflictStepResult(
        step,
        {kind: 'expected-world', revision: {pageEpoch: 'epoch-a', captureRevision: 1}},
        {pageEpoch: 'epoch-a', captureRevision: 2},
    );
    assert.deepEqual(result, {
        stepId: 's1',
        ok: false,
        error: {
            code: 'ERR_AGENT_WORLD_CONFLICT',
            message: 'workspace world moved past the expected observation revision; refusing to mutate',
            details: {
                expected: {pageEpoch: 'epoch-a', captureRevision: 1},
                actual: {pageEpoch: 'epoch-a', captureRevision: 2},
            },
        },
    });
    assert.ok(!JSON.stringify(result).includes('SECRET'), 'conflict metadata must not echo step args');
});