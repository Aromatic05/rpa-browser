import test from 'node:test';
import assert from 'node:assert/strict';
import {computeAgentEvalAggregates} from '../../../../../src/agent/execution/eval/aggregate';
import type {AgentEvalMetrics, AgentEvalRun} from '../../../../../src/agent/execution/eval/contracts';

const makeRun = (
    mode: 'program' | 'react-baseline',
    overrides: {
        success?: boolean;
        durationMs?: number;
        recoverySuccess?: boolean | null;
        failedWorldChangingEffects?: number | null;
        compensationEffects?: number | null;
        worldEffectCalls?: number | null;
        context?: AgentEvalMetrics['context'];
    } = {},
): AgentEvalRun => {
    const baseMetrics: AgentEvalMetrics = {
        turns: 2,
        toolCalls: 4,
        readCalls: 1,
        controlCalls: 3,
        effectCalls: mode === 'program' ? 0 : 1,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
        taskSuccess: overrides.success ?? true,
        recoverySuccess: overrides.recoverySuccess ?? (mode === 'program' ? true : null),
        durationMs: overrides.durationMs ?? 100,
        effects: {
            toolEffectCalls: mode === 'program' ? 0 : 1,
            worldEffectCalls: overrides.worldEffectCalls ?? (mode === 'program' ? 1 : null),
            failedWorldChangingEffects: overrides.failedWorldChangingEffects ?? (mode === 'program' ? 0 : null),
            compensationEffects: overrides.compensationEffects ?? (mode === 'program' ? 0 : null),
            availability: mode === 'program' ? 'program-journal' : 'not-exposed',
        },
        context: overrides.context ?? {
            availability: 'not-exposed',
            peakChars: null,
            peakBytes: null,
            lastChars: null,
            lastBytes: null,
        },
        repair: {
            rewindCalls: 0,
            rollbackCalls: 0,
            patchCalls: 0,
            recomputeCalls: 0,
            refreshCalls: 0,
        },
    };
    return {
        taskId: 't',
        mode,
        trialIndex: 0,
        success: baseMetrics.taskSuccess,
        durationMs: baseMetrics.durationMs,
        verification: {passed: baseMetrics.taskSuccess},
        metrics: baseMetrics,
        result: {
            provider: 'p',
            model: 'm',
            text: 'ok',
            trace: {metrics: baseMetrics, tools: []},
            executionMode: mode,
        },
    };
};

test('aggregate computes rates and distributions across trials', () => {
    const runs = {
        program: [
            makeRun('program', {durationMs: 100}),
            makeRun('program', {durationMs: 200}),
            makeRun('program', {durationMs: 300}),
        ],
    };
    const aggregates = computeAgentEvalAggregates(runs);
    const program = aggregates.program;
    assert.ok(program);
    assert.equal(program.trials, 3);
    assert.equal(program.taskSuccess.count, 3);
    assert.equal(program.taskSuccess.passed, 3);
    assert.equal(program.taskSuccess.rate, 1);
    assert.equal(program.durationMs.count, 3);
    assert.equal(program.durationMs.sum, 600);
    assert.equal(program.durationMs.min, 100);
    assert.equal(program.durationMs.max, 300);
    assert.equal(program.durationMs.mean, 200);
    assert.equal(program.recoverySuccess && 'passed' in program.recoverySuccess ? program.recoverySuccess.passed : null, 3);
});

test('aggregate marks unknown metrics when mode cannot observe them', () => {
    const runs = {
        'react-baseline': [makeRun('react-baseline')],
    };
    const aggregates = computeAgentEvalAggregates(runs);
    const baseline = aggregates['react-baseline'];
    assert.ok(baseline);
    assert.equal(baseline.recoverySuccess && 'unknown' in baseline.recoverySuccess, true);
    assert.equal(baseline.failedWorldChangingEffects && 'unknown' in baseline.failedWorldChangingEffects, true);
    assert.equal(baseline.compensationEffects && 'unknown' in baseline.compensationEffects, true);
    assert.equal(baseline.worldEffectCalls && 'unknown' in baseline.worldEffectCalls, true);
});

test('aggregate reports partial success rates', () => {
    const runs = {
        program: [
            makeRun('program', {success: true}),
            makeRun('program', {success: false}),
            makeRun('program', {success: false}),
        ],
    };
    const aggregates = computeAgentEvalAggregates(runs);
    assert.equal(aggregates.program?.taskSuccess.rate, 1 / 3);
});

test('aggregate ignores empty mode lists', () => {
    const aggregates = computeAgentEvalAggregates({});
    assert.deepEqual(aggregates, {});
});

test('aggregate carries context distributions when provider-visible', () => {
    const runs = {
        program: [
            makeRun('program', {
                context: {
                    availability: 'provider-visible',
                    peakChars: 1000, peakBytes: 1200, lastChars: 900, lastBytes: 1100,
                },
            }),
            makeRun('program', {
                context: {
                    availability: 'provider-visible',
                    peakChars: 2000, peakBytes: 2400, lastChars: 1800, lastBytes: 2100,
                },
            }),
        ],
    };
    const aggregates = computeAgentEvalAggregates(runs);
    const program = aggregates.program;
    assert.ok(program);
    const context = program.context;
    assert.ok('count' in context.peakChars);
    assert.equal(context.peakChars.count, 2);
    assert.equal(context.peakChars.mean, 1500);
    assert.equal(context.peakChars.min, 1000);
    assert.equal(context.peakChars.max, 2000);
    assert.ok('count' in context.lastBytes);
    assert.equal(context.lastBytes.sum, 3200);
    assert.equal(context.lastBytes.mean, 1600);
});

test('aggregate marks context unknown when a mode never exposes context accounting', () => {
    const runs = {
        'react-baseline': [makeRun('react-baseline')],
    };
    const aggregates = computeAgentEvalAggregates(runs);
    const baseline = aggregates['react-baseline'];
    assert.ok(baseline);
    assert.equal(baseline.context.peakChars && 'unknown' in baseline.context.peakChars, true);
    assert.equal(baseline.context.peakBytes && 'unknown' in baseline.context.peakBytes, true);
    assert.equal(baseline.context.lastChars && 'unknown' in baseline.context.lastChars, true);
    assert.equal(baseline.context.lastBytes && 'unknown' in baseline.context.lastBytes, true);
});
