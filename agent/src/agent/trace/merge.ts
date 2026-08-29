import type {AgentTraceSnapshot} from './collector';
import {createRedactionPolicy, type RedactionPolicy} from '../../security/redaction';

export const mergeAgentTraceSnapshots = (
    snapshots: readonly AgentTraceSnapshot[],
    redact?: RedactionPolicy,
): AgentTraceSnapshot => {
    const policy = redact ?? createRedactionPolicy();
    return {
        metrics: snapshots.reduce((total, snapshot) => ({
            turns: total.turns + snapshot.metrics.turns,
            toolCalls: total.toolCalls + snapshot.metrics.toolCalls,
            readCalls: total.readCalls + snapshot.metrics.readCalls,
            controlCalls: total.controlCalls + snapshot.metrics.controlCalls,
            effectCalls: total.effectCalls + snapshot.metrics.effectCalls,
            failedToolCalls: total.failedToolCalls + snapshot.metrics.failedToolCalls,
            postErrorEffectCalls: total.postErrorEffectCalls + snapshot.metrics.postErrorEffectCalls,
        }), {
            turns: 0,
            toolCalls: 0,
            readCalls: 0,
            controlCalls: 0,
            effectCalls: 0,
            failedToolCalls: 0,
            postErrorEffectCalls: 0,
        }),
        tools: snapshots
            .flatMap((snapshot) => structuredClone(snapshot.tools)
                .map((tool) => ({...tool, args: policy.redact(tool.args).value})))
            .sort((left, right) => left.startedAt - right.startedAt),
    };
};
