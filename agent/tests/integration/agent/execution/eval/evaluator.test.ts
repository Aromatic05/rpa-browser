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
    const prepares: Array<{mode: string; trialIndex: number}> = [];
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
                        effects: [{
                            sequence: 1,
                            stepName: 'browser.fill',
                            status: 'succeeded' as const,
                            worldBefore: {pageEpoch: 'page-1', captureRevision: 1},
                            worldAfter: {pageEpoch: 'page-1', captureRevision: 2},
                        }],
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
        prepare: async (mode, trialIndex) => {prepares.push({mode, trialIndex});},
        verify: (result) => ({passed: result.text === 'verified', evidence: result.text}),
    });

    assert.deepEqual(prepares, [{mode: 'program', trialIndex: 0}, {mode: 'react-baseline', trialIndex: 0}]);
    assert.equal(report.runs.program?.success, true);
    assert.equal(report.runs.program?.trialIndex, 0);
    assert.equal(typeof report.runs.program?.durationMs, 'number');
    assert.equal(report.runs['react-baseline']?.success, false);
    assert.equal(report.runs.program?.metrics.taskSuccess, true);
    assert.equal(report.runs.program?.metrics.recoverySuccess, true);
    assert.equal(report.runs.program?.metrics.effects.worldEffectCalls, 1);
    assert.equal(report.runs.program?.metrics.effects.failedWorldChangingEffects, 0);
    assert.equal(report.runs.program?.metrics.effects.compensationEffects, 0);
    assert.equal(report.runs.program?.metrics.effects.availability, 'program-journal');
    assert.equal(report.runs.program?.metrics.repair.patchCalls, 1);
    assert.equal(report.runs.program?.metrics.repair.rewindCalls, 1);
    assert.equal(report.runs['react-baseline']?.metrics.effects.toolEffectCalls, 1);
    assert.equal(report.runs['react-baseline']?.metrics.effects.worldEffectCalls, null);
    assert.equal(report.runs['react-baseline']?.metrics.recoverySuccess, null);
    assert.equal(report.runs['react-baseline']?.metrics.effects.failedWorldChangingEffects, null);
    assert.equal(report.runs['react-baseline']?.metrics.effects.compensationEffects, null);
    assert.equal(report.runs['react-baseline']?.metrics.effects.availability, 'not-exposed');
});

test('eval can run only one mode for product-only regression tasks', async () => {
    const calls: Array<{mode: string; trialIndex: number}> = [];
    const runner: AgentRunner = {
        run: async (request) => {
            calls.push({mode: request.executionMode ?? 'missing', trialIndex: (request.input?.trialIndex as number) ?? 0});
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

    assert.deepEqual(calls, [{mode: 'program', trialIndex: 0}]);
    assert.equal(report.runs.program?.success, true);
    assert.equal(report.runs['react-baseline'], undefined);
});

test('eval passes trial index through prepare and verify', async () => {
    const seenTrials: number[] = [];
    const runner: AgentRunner = {
        run: async () => ({
            provider: 'faux',
            model: 'model',
            text: 'ok',
            trace: trace('program'),
        }),
    };
    await evaluateAgentTask({runner, modes: ['program']}, {
        id: 'trial-aware',
        prompt: 'task',
        provider: 'p',
        model: 'm',
        prepare: async (_mode, trialIndex) => { seenTrials.push(trialIndex); },
        verify: async (_result, _mode, trialIndex) => {
            seenTrials.push(trialIndex);
            return true;
        },
    }, {trialIndex: 7});

    assert.deepEqual(seenTrials, [7, 7]);
});
