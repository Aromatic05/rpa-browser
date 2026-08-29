import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAgentTask} from '../../../../../src/agent/execution/eval/evaluator';
import type {AgentRunner} from '../../../../../src/agent/execution/types';

const trace = (mode: 'program' | 'react-baseline') => ({
    metrics: {
        turns: 3,
        toolCalls: mode === 'program' ? 4 : 2,
        readCalls: 1,
        controlCalls: mode === 'program' ? 3 : 0,
        effectCalls: mode === 'program' ? 0 : 1,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    },
    tools: mode === 'program'
        ? [
            {toolCallId: '1', toolName: 'agent.execute_program', classification: 'control' as const, args: {}, startedAt: 1},
            {toolCallId: '2', toolName: 'debug.patch_program', classification: 'control' as const, args: {}, startedAt: 2},
            {toolCallId: '3', toolName: 'debug.rewind', classification: 'control' as const, args: {}, startedAt: 3},
            {toolCallId: '4', toolName: 'debug.continue', classification: 'control' as const, args: {}, startedAt: 4},
        ]
        : [
            {toolCallId: '5', toolName: 'browser.snapshot', classification: 'read' as const, args: {}, startedAt: 1},
            {toolCallId: '6', toolName: 'browser.click', classification: 'effect' as const, args: {}, startedAt: 2},
        ],
});

test('eval compares program-first and baseline without inventing hidden world-effect counts', async () => {
    const prepares: string[] = [];
    const runner: AgentRunner = {
        run: async (request) => {
            const mode = request.executionMode ?? 'program';
            return {
                provider: request.provider,
                model: request.model,
                text: mode === 'program' ? 'verified' : 'done',
                trace: trace(mode),
                executionMode: mode,
                ...(mode === 'program'
                    ? {programs: [{
                        source: 'fill input.target with input.value',
                        input: {},
                        status: 'completed' as const,
                        effects: [{sequence: 1, stepName: 'browser.fill', status: 'succeeded' as const}],
                    }]}
                    : {}),
            };
        },
    };

    const report = await evaluateAgentTask({runner}, {
        id: 'fill-and-submit',
        prompt: 'Complete the form.',
        provider: 'faux',
        model: 'model',
        prepare: async (mode) => {prepares.push(mode);},
        verify: (result) => ({passed: result.text === 'verified', evidence: result.text}),
    });

    assert.deepEqual(prepares, ['program', 'react-baseline']);
    assert.equal(report.runs.program?.success, true);
    assert.equal(report.runs['react-baseline']?.success, false);
    assert.equal(report.runs.program?.metrics.effects.worldEffectCalls, 1);
    assert.equal(report.runs.program?.metrics.effects.availability, 'program-journal');
    assert.equal(report.runs.program?.metrics.repair.patchCalls, 1);
    assert.equal(report.runs.program?.metrics.repair.rewindCalls, 1);
    assert.equal(report.runs['react-baseline']?.metrics.effects.toolEffectCalls, 1);
    assert.equal(report.runs['react-baseline']?.metrics.effects.worldEffectCalls, null);
    assert.equal(report.runs['react-baseline']?.metrics.effects.availability, 'not-exposed');
});

test('eval can run only one mode for product-only regression tasks', async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
        run: async (request) => {
            calls.push(request.executionMode ?? 'missing');
            return {
                provider: request.provider,
                model: request.model,
                text: 'ok',
                trace: trace('program'),
            };
        },
    };
    const report = await evaluateAgentTask({runner, modes: ['program']}, {
        id: 'product',
        prompt: 'task',
        provider: 'p',
        model: 'm',
        verify: () => true,
    });

    assert.deepEqual(calls, ['program']);
    assert.equal(report.runs.program?.success, true);
    assert.equal(report.runs['react-baseline'], undefined);
});
