import test from 'node:test';
import assert from 'node:assert/strict';
import {collectAgentEvalMetrics} from '../../../../../src/agent/execution/eval/metrics';
import type {AgentRunResult} from '../../../../../src/agent/execution/types';

const baseResult = (): AgentRunResult => ({
    provider: 'faux',
    model: 'model-x',
    text: 'done',
    executionMode: 'program',
    trace: {
        metrics: {
            turns: 2,
            toolCalls: 1,
            readCalls: 0,
            controlCalls: 1,
            effectCalls: 0,
            failedToolCalls: 0,
            postErrorEffectCalls: 0,
        },
        tools: [],
    },
    programs: [],
});

test('context metrics are provider-visible with exact sizes when the trace exposes accounting', () => {
    const result = baseResult();
    result.trace.context = {
        turns: [
            {turn: 1, chars: 120, bytes: 120},
            {turn: 2, chars: 400, bytes: 412},
        ],
        lastChars: 400,
        lastBytes: 412,
        peakChars: 400,
        peakBytes: 412,
    };
    const metrics = collectAgentEvalMetrics(result, 'program', true, 100);
    assert.deepEqual(metrics.context, {
        availability: 'provider-visible',
        peakChars: 400,
        peakBytes: 412,
        lastChars: 400,
        lastBytes: 412,
    });
});

test('context metrics stay unknown, never zero, when the runner exposes no accounting', () => {
    const metrics = collectAgentEvalMetrics(baseResult(), 'react-baseline', true, 100);
    assert.deepEqual(metrics.context, {
        availability: 'not-exposed',
        peakChars: null,
        peakBytes: null,
        lastChars: null,
        lastBytes: null,
    });
    assert.equal(metrics.context.peakChars, null);
    assert.equal(metrics.context.peakChars === 0, false);
    assert.equal(metrics.context.lastBytes, null);
    assert.equal(metrics.context.lastBytes === 0, false);
});