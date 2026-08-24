import type {DebugEffectJournalEntry} from '../../effects/contracts';
import type {RuntimeStateRecord} from '../../../../automation/snapshot/observation/model/contracts';
import type {DebugPhysicalCompensationPlan} from './contracts';
import {classifyEffectSemanticRisk} from './semantics';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const previousEditableValue = (
    runtime: RuntimeStateRecord | undefined,
): string | undefined => runtime?.value ?? runtime?.contentEditableText;

export const planPhysicalCompensation = (
    entry: DebugEffectJournalEntry,
): DebugPhysicalCompensationPlan => {
    const semanticRisk = classifyEffectSemanticRisk(entry.record.effect);
    const unavailable = (
        reason: Extract<DebugPhysicalCompensationPlan, {status: 'unavailable'}>['reason'],
    ): DebugPhysicalCompensationPlan => Object.freeze({
        status: 'unavailable' as const,
        semanticRisk,
        reason,
        effectSequence: entry.record.sequence,
    });

    if (semanticRisk === 'irreversible') {
        return unavailable('explicit_irreversible');
    }

    if (entry.record.effect.stepName !== 'browser.fill') {
        return unavailable('unsupported_effect');
    }
    if (!isRecord(entry.record.effect.args)) {
        return unavailable('explicit_target_required');
    }
    const nodeId = entry.record.effect.args.nodeId;
    if (typeof nodeId !== 'string' || !nodeId) {
        return unavailable('explicit_target_required');
    }
    const runtime = entry.worldBefore.entry.capture.control.observation.runtimeState[nodeId];
    const value = previousEditableValue(runtime);
    if (value === undefined) {
        return unavailable('previous_value_unavailable');
    }
    return Object.freeze({
        status: 'available' as const,
        semanticRisk,
        capability: 'restore_value' as const,
        effectSequence: entry.record.sequence,
        operation: Object.freeze({
            name: 'browser.fill' as const,
            args: Object.freeze({nodeId, value}),
        }),
    });
};
