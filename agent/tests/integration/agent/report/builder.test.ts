import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentRunReport} from '../../../../src/agent/report/builder';
import {serializeAgentRunReport} from '../../../../src/agent/report/serialization';
import {
    baselineResult,
    compileInvalidResult,
    successResult,
    verifiedRewindRepairResult,
} from './fixtures';

test('report builder captures a successful program run with journal, artifacts, and revisions', () => {
    const result = successResult();
    const report = buildAgentRunReport(result);

    assert.equal(report.schema, 'rpa.agent.run-report');
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.run, {provider: 'faux', model: 'model-x', executionMode: 'program'});
    assert.deepEqual(report.terminal, {status: 'completed', output: '{"done":true}'});
    assert.equal(report.generatedAt, undefined);

    assert.deepEqual(report.toolMetrics, {
        turns: 3,
        toolCalls: 4,
        readCalls: 2,
        controlCalls: 2,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
        repair: {rewindCalls: 0, rollbackCalls: 0, patchCalls: 0, recomputeCalls: 0, refreshCalls: 0},
    });

    assert.deepEqual(report.programs, [{
        index: 0,
        status: 'completed',
        source: 'fill order.orderForm.buyer with input.value\noutput done = input.done',
        materializedSource: 'fill order.orderForm.buyer with input.value\noutput done = input.done',
        inputKeys: ['done', 'value'],
        output: '{"done":true}',
        effectsExposed: true,
        effectCount: 1,
    }]);
    assert.equal(JSON.stringify(report.programs).includes('new value'), false);

    assert.deepEqual(report.effects.availability, 'program-journal');
    assert.equal(report.effects.worldEffectCalls, 1);
    assert.deepEqual(report.effects.failedWorldChangingEffects, []);
    assert.deepEqual(report.effects.compensationEffects, []);
    assert.deepEqual(report.effects.records, [{
        programIndex: 0,
        sequence: 1,
        stepName: 'browser.fill',
        status: 'succeeded',
        worldChanged: true,
        worldBefore: {pageEpoch: 'page-1', captureRevision: 1},
        worldAfter: {pageEpoch: 'page-1', captureRevision: 2},
        compensatedBy: [],
    }]);

    assert.deepEqual(report.world.revisionsObserved, [
        {pageEpoch: 'page-1', captureRevision: 1},
        {pageEpoch: 'page-1', captureRevision: 2},
    ]);

    assert.deepEqual(report.savedArtifacts, [
        {kind: 'program', name: 'order-fill', artifactRevision: 'artifact-rev-3'},
    ]);

    assert.deepEqual(report.context, {
        lastChars: 400,
        lastBytes: 412,
        peakChars: 400,
        peakBytes: 412,
        turns: [
            {turn: 1, chars: 120, bytes: 120},
            {turn: 2, chars: 260, bytes: 268},
            {turn: 3, chars: 400, bytes: 412},
        ],
    });

    assert.equal(report.toolCalls.length, 4);
    assert.deepEqual(report.toolCalls[0], {
        toolCallId: 't1',
        toolName: 'browser.snapshot',
        classification: 'read',
        isError: false,
        startedAt: 100,
        endedAt: 110,
        durationMs: 10,
        args: {tabName: 'main'},
        redactedPaths: [],
        worldBefore: {pageEpoch: 'page-1', captureRevision: 1, freshness: 'fresh'},
        worldAfter: {pageEpoch: 'page-1', captureRevision: 1, freshness: 'fresh'},
    });
    assert.equal(report.toolCalls[1].durationMs, 20);
    assert.equal(report.toolCalls[1].worldBefore, null);
    assert.equal(report.toolCalls[1].worldAfter, null);
});

test('report builder records compile-invalid programs with explicit unknown effect exposure', () => {
    const report = buildAgentRunReport(compileInvalidResult());

    assert.deepEqual(report.terminal.status, 'invalid');
    assert.equal(report.terminal.error?.code, 'ERR_DSL_COMPILE');
    assert.equal(report.terminal.error?.message, 'unexpected token in fill statement');
    assert.deepEqual(report.terminal.error?.details, {
        sourceLine: 'fill ??? with input.value',
        scope: {value: 'x', password: '[redacted]'},
    });
    assert.equal(report.terminal.output, 'the program failed to compile');

    assert.deepEqual(report.programs, [{
        index: 0,
        status: 'invalid',
        source: 'fill ??? with input.value',
        inputKeys: ['value'],
        error: {
            code: 'ERR_DSL_COMPILE',
            message: 'unexpected token in fill statement',
            details: {
                sourceLine: 'fill ??? with input.value',
                scope: {value: 'x', password: '[redacted]'},
            },
        },
        effectsExposed: false,
        effectCount: null,
    }]);

    assert.deepEqual(report.effects, {
        availability: 'not-exposed',
        worldEffectCalls: null,
        failedWorldChangingEffects: [],
        compensationEffects: [],
        records: [],
    });
    assert.deepEqual(report.savedArtifacts, []);
    assert.equal(report.toolMetrics.failedToolCalls, 1);
});

test('report builder does not claim a journal when program mode produced no program summaries', () => {
    const result = successResult();
    result.programs = [];
    const report = buildAgentRunReport(result);

    assert.deepEqual(report.run.executionMode, 'program');
    assert.deepEqual(report.effects, {
        availability: 'not-exposed',
        worldEffectCalls: null,
        failedWorldChangingEffects: [],
        compensationEffects: [],
        records: [],
    });
});

test('report builder keeps baseline runs honest when no effect journal exists', () => {
    const report = buildAgentRunReport(baselineResult());

    assert.deepEqual(report.run.executionMode, 'react-baseline');
    assert.deepEqual(report.terminal, {status: 'completed', output: 'clicked the submit button'});
    assert.deepEqual(report.programs, []);
    assert.deepEqual(report.effects, {
        availability: 'not-exposed',
        worldEffectCalls: null,
        failedWorldChangingEffects: [],
        compensationEffects: [],
        records: [],
    });
    assert.deepEqual(report.world.revisionsObserved, [
        {pageEpoch: 'page-9', captureRevision: 4},
        {pageEpoch: 'page-9', captureRevision: 5},
    ]);
    assert.equal(report.toolMetrics.effectCalls, 1);
    assert.equal(report.context, undefined);
});

test('report builder surfaces verified rewind repair through repair metrics and terminal state', () => {
    const report = buildAgentRunReport(verifiedRewindRepairResult());

    assert.deepEqual(report.terminal, {status: 'completed', output: '{"done":true}'});
    assert.deepEqual(report.toolMetrics.repair, {
        rewindCalls: 1,
        rollbackCalls: 0,
        patchCalls: 1,
        recomputeCalls: 1,
        refreshCalls: 0,
    });
    assert.deepEqual(report.programs[0].status, 'completed');
    assert.equal(report.programs[0].materializedSource, 'fill order.orderForm.buyer with input.value\noutput done = true');
    assert.equal(report.effects.availability, 'program-journal');
    assert.deepEqual(report.effects.records[0], {
        programIndex: 0,
        sequence: 1,
        stepName: 'browser.fill',
        status: 'succeeded',
        worldChanged: true,
        worldBefore: {pageEpoch: 'page-1', captureRevision: 2},
        worldAfter: {pageEpoch: 'page-1', captureRevision: 3},
        compensatedBy: [],
    });
});

test('report builder marks missing execution mode as unknown instead of guessing', () => {
    const result = baselineResult();
    delete result.executionMode;
    const report = buildAgentRunReport(result);
    assert.equal(report.run.executionMode, 'unknown');
    assert.deepEqual(report.effects.availability, 'not-exposed');
});

test('report builder is deterministic and never mutates its input', () => {
    const result = successResult();
    const pristine = structuredClone(result);
    const first = serializeAgentRunReport(buildAgentRunReport(result));
    const second = serializeAgentRunReport(buildAgentRunReport(structuredClone(result)));
    assert.equal(first, second);
    assert.deepEqual(result, pristine);

    const withGeneratedAt = buildAgentRunReport(result, {generatedAt: '2026-08-29T00:00:00.000Z'});
    assert.equal(withGeneratedAt.generatedAt, '2026-08-29T00:00:00.000Z');
    assert.equal(buildAgentRunReport(result).generatedAt, undefined);
});
