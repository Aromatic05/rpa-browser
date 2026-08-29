import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentProgramEffectSummary} from '../../../../../../src/agent/execution/types';
import type {AgentFaultEvent} from '../../../../../../src/agent/execution/eval/faults/contracts';
import {
    analyzeFaultTrial,
    faultRecoverySuccess,
} from '../../../../../../src/agent/execution/eval/faults/semantics';

const BASE = {name: 'Before'};

const event = (
    sequence: number,
    kind: AgentFaultEvent['kind'],
    key: string,
    extra: Partial<Omit<AgentFaultEvent, 'sequence' | 'kind' | 'key'>> = {},
): AgentFaultEvent => Object.freeze({sequence, kind, key, epoch: 1, revision: sequence, ...extra});

const effect = (
    sequence: number,
    stepName: string,
    status: AgentProgramEffectSummary['status'],
    revision: number,
    compensates?: number,
): AgentProgramEffectSummary => Object.freeze({
    sequence,
    stepName,
    status,
    worldBefore: {pageEpoch: 'epoch-1', captureRevision: revision - 1},
    worldAfter: {pageEpoch: 'epoch-1', captureRevision: revision},
    ...(compensates === undefined ? {} : {compensates}),
});

test('a re-applied effect after a rewind, when the verified world already holds the value, is replay', () => {
    const events = [
        event(1, 'load', 'fault-form'),
        event(2, 'read', 'name', {value: 'Before'}),
        event(3, 'drift', 'name', {worldChanged: true}),
        event(4, 'read', 'name', {value: ''}),
        event(5, 'fill-applied', 'name', {value: 'Alice', worldChanged: true}),
        event(6, 'read', 'name', {value: 'Alice'}),
        event(7, 'fill-applied', 'name', {value: 'Alice', worldChanged: true}),
    ];
    const summary = analyzeFaultTrial(events, BASE, null);
    assert.equal(summary.redundantAppliedEffects, 1);
    assert.equal(summary.postRewindReplayEffects, 1);
    assert.equal(faultRecoverySuccess('revision-drift', summary, false), false,
        'post-rewind replay invalidates recovery in any mode');
});

test('the first post-drift write is recovery, not replay, because the drift cleared the value', () => {
    const events = [
        event(1, 'load', 'fault-form'),
        event(2, 'drift', 'name', {worldChanged: true}),
        event(3, 'read', 'name', {value: ''}),
        event(4, 'fill-applied', 'name', {value: 'Alice', worldChanged: true}),
    ];
    const summary = analyzeFaultTrial(events, BASE, null);
    assert.equal(summary.redundantAppliedEffects, 0);
    assert.equal(summary.postRewindReplayEffects, 0);
});

test('a restore write is transactional only when the journal links it to the failed effect', () => {
    const events = [
        event(1, 'load', 'fault-form'),
        event(2, 'read', 'name', {value: 'Before'}),
        event(3, 'fill-failed-after-apply', 'name', {value: 'Alice~partial', worldChanged: true, reason: 'ERR_FAULT_PARTIAL_APPLY'}),
        event(4, 'read', 'name', {value: 'Alice~partial'}),
        event(5, 'fill-applied', 'name', {value: 'Before', worldChanged: true}),
    ];
    const journal = [
        effect(1, 'browser.fill', 'failed', 4),
        effect(2, 'debug.compensate', 'succeeded', 5, 1),
    ];
    const linked = analyzeFaultTrial(events, BASE, journal);
    assert.equal(linked.journaledCompensations, 1);
    assert.equal(linked.adHocRestores, 0);
    assert.equal(linked.failedAfterApplyByAgent, 1);
    assert.equal(faultRecoverySuccess('transactional-restore', linked, true), true);

    const unlinked = analyzeFaultTrial(events, BASE, null);
    assert.equal(unlinked.journaledCompensations, 0);
    assert.equal(unlinked.adHocRestores, 1, 'without a journal the same write can only be attributed as ad-hoc');
    assert.equal(faultRecoverySuccess('transactional-restore', unlinked, false), true);
});

test('conflict and external-mutation counters only fire on their real signals', () => {
    const events = [
        event(1, 'load', 'fault-form'),
        event(2, 'read', 'name', {value: 'Before'}),
        event(3, 'external-mutate', 'name', {value: 'External-edit', worldChanged: true}),
        event(4, 'fill-rejected', 'name', {value: 'Alice', worldChanged: false, reason: 'ERR_FAULT_REVISION_CONFLICT'}),
        event(5, 'fill-rejected', 'name', {value: 'Alice', worldChanged: false, reason: 'ERR_STALE_TARGET'}),
        event(6, 'fill-applied', 'name', {value: 'Alice', worldChanged: true}),
    ];
    const summary = analyzeFaultTrial(events, BASE, null);
    assert.equal(summary.externalMutations, 1);
    assert.equal(summary.conflictsDetected, 1);
    assert.equal(summary.rejectedEffects, 2);
    assert.equal(summary.failedAfterApplyByAgent, 0, 'rejections never changed the world through the agent');
});
