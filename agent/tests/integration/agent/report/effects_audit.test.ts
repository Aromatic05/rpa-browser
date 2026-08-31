import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentRunReport} from '../../../../src/agent/report/builder';
import {compensatedRollbackResult} from './fixtures';

test('report builder audits failed world-changing effects with compensation linkage', () => {
    const report = buildAgentRunReport(compensatedRollbackResult());

    assert.deepEqual(report.terminal, {
        status: 'failed',
        output: 'rolled back to the savepoint',
        error: {code: 'ERR_ENSURE_VIOLATED', message: 'postcondition not satisfied'},
    });
    assert.deepEqual(report.toolMetrics.repair.rollbackCalls, 1);

    assert.equal(report.effects.availability, 'program-journal');
    assert.equal(report.effects.worldEffectCalls, 4);
    assert.equal(report.effects.records.length, 4);

    assert.deepEqual(report.effects.failedWorldChangingEffects, [{
        programIndex: 0,
        sequence: 2,
        stepName: 'browser.click',
        status: 'failed',
        worldChanged: true,
        worldBefore: {pageEpoch: 'page-1', captureRevision: 2},
        worldAfter: {pageEpoch: 'page-1', captureRevision: 3},
        compensatedBy: [3],
    }]);

    assert.deepEqual(
        report.effects.compensationEffects.map((effect) => effect.sequence),
        [3, 4],
    );
    assert.deepEqual(report.effects.compensationEffects[0].compensates, 2);
    assert.deepEqual(report.effects.compensationEffects[1].compensates, 1);

    const bySequence = new Map(report.effects.records.map((effect) => [effect.sequence, effect]));
    assert.deepEqual(bySequence.get(1)?.compensatedBy, [4]);
    assert.deepEqual(bySequence.get(2)?.compensatedBy, [3]);
    assert.deepEqual(bySequence.get(3)?.compensatedBy, []);
    assert.deepEqual(bySequence.get(4)?.compensatedBy, []);

    assert.deepEqual(report.world.revisionsObserved, [
        {pageEpoch: 'page-1', captureRevision: 1},
        {pageEpoch: 'page-1', captureRevision: 2},
        {pageEpoch: 'page-1', captureRevision: 3},
    ]);
});

test('failed effects that left the world untouched are not reported as world-changing', () => {
    const result = compensatedRollbackResult();
    const attempt = result.programs![0];
    const effects = attempt.effects!.map((item, index) => index === 1
        ? {...item, worldAfter: {...item.worldBefore}}
        : item);
    const report = buildAgentRunReport({...result, programs: [{...attempt, effects}]});

    assert.deepEqual(report.effects.failedWorldChangingEffects, []);
    assert.equal(report.effects.records[1].worldChanged, false);
});
