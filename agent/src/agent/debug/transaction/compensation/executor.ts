import crypto from 'node:crypto';
import type {DslEffectDescriptor, DslEffectOutcome, DslScopeSnapshot, DslStatementLocation} from '../../../../program/dsl/debug/contracts';
import type {StepResult, StepUnion} from '../../../../runner/steps/types';
import type {WorldView, WorldViewSource} from '../../../worldview/contracts';
import type {DebugEffectJournal, DebugEffectJournalEntry, DebugEffectRecord} from '../../effects/contracts';
import {UNKNOWN_EFFECT_SEMANTICS} from '../../../../program/effects/declaration';
import type {
    DebugCompensationPort,
    DebugEffectSemanticRisk,
    DebugPhysicalCompensationPlan,
} from './contracts';
import {planPhysicalCompensation} from './planner';

export type DebugPhysicalCompensationExecutionResult =
    | Readonly<{
        status: 'completed';
        semanticRisk: DebugEffectSemanticRisk;
        compensations: readonly DebugEffectRecord[];
        world: WorldView;
    }>
    | Readonly<{
        status: 'blocked';
        reason: 'compensation_unavailable';
        plans: readonly DebugPhysicalCompensationPlan[];
    }>
    | Readonly<{
        status: 'failed';
        semanticRisk: DebugEffectSemanticRisk;
        compensations: readonly DebugEffectRecord[];
        failure: Readonly<{code: string; message: string; details?: unknown}>;
        world: WorldView;
    }>;

export type ExecutePhysicalCompensationsOptions = {
    entries: readonly DebugEffectJournalEntry[];
    port: DebugCompensationPort;
    worldViewSource: WorldViewSource;
    journal: DebugEffectJournal;
    location: DslStatementLocation;
    scope: DslScopeSnapshot;
};

const aggregateSemanticRisk = (
    plans: readonly Extract<DebugPhysicalCompensationPlan, {status: 'available'}>[],
): DebugEffectSemanticRisk => {
    if (plans.some((plan) => plan.semanticRisk === 'irreversible')) {return 'irreversible';}
    if (plans.some((plan) => plan.semanticRisk === 'unknown')) {return 'unknown';}
    return 'compensatable';
};

const normalizeExecutionFailure = (error: unknown): StepResult['error'] => {
    if (error && typeof error === 'object') {
        const value = error as {code?: unknown; message?: unknown; details?: unknown};
        return {
            code: typeof value.code === 'string' ? value.code : 'ERR_COMPENSATION_EXECUTION',
            message: typeof value.message === 'string' ? value.message : 'compensation execution failed',
            ...(value.details === undefined ? {} : {details: structuredClone(value.details)}),
        };
    }
    return {
        code: 'ERR_COMPENSATION_EXECUTION',
        message: typeof error === 'string' ? error : 'compensation execution failed',
    };
};

const toOutcome = (result: StepResult): DslEffectOutcome => result.ok
    ? Object.freeze({status: 'succeeded' as const})
    : Object.freeze({
        status: 'failed' as const,
        error: Object.freeze({
            code: result.error?.code ?? 'ERR_COMPENSATION_EXECUTION',
            message: result.error?.message ?? 'compensation execution failed',
            ...(result.error?.details === undefined ? {} : {details: structuredClone(result.error.details)}),
        }),
    });

export const executePhysicalCompensations = async (
    options: ExecutePhysicalCompensationsOptions,
): Promise<DebugPhysicalCompensationExecutionResult> => {
    const planned = options.entries.map(planPhysicalCompensation);
    if (planned.some((plan) => plan.status === 'unavailable')) {
        return Object.freeze({
            status: 'blocked' as const,
            reason: 'compensation_unavailable' as const,
            plans: Object.freeze([...planned]),
        });
    }
    const plans = planned as Array<Extract<DebugPhysicalCompensationPlan, {status: 'available'}>>;
    const semanticRisk = aggregateSemanticRisk(plans);
    const compensations: DebugEffectRecord[] = [];
    let world = await options.worldViewSource.pin();

    for (const plan of [...plans].reverse()) {
        const step = {
            id: `compensation:${crypto.randomUUID()}`,
            name: plan.operation.name,
            args: structuredClone(plan.operation.args),
        } as StepUnion;
        const effect: DslEffectDescriptor = Object.freeze({
            stepId: step.id,
            stepName: step.name,
            args: structuredClone(step.args),
            semantics: UNKNOWN_EFFECT_SEMANTICS,
        });
        const before = await options.worldViewSource.pin();
        options.journal.begin(Object.freeze({
            location: options.location,
            scope: options.scope,
            effect,
        }), before, {compensates: {effectSequence: plan.effectSequence}});

        let result: StepResult;
        try {
            result = await options.port.execute(step);
        } catch (error) {
            result = {stepId: step.id, ok: false, error: normalizeExecutionFailure(error)};
        }
        world = await options.worldViewSource.pin();
        options.journal.finish(Object.freeze({
            location: options.location,
            effect,
            outcome: toOutcome(result),
        }), world);
        const record = options.journal.list().at(-1);
        if (!record) {throw new Error('compensation effect was not journaled');}
        compensations.push(record);
        if (!result.ok) {
            return Object.freeze({
                status: 'failed' as const,
                semanticRisk,
                compensations: Object.freeze([...compensations]),
                failure: Object.freeze(result.error ?? {
                    code: 'ERR_COMPENSATION_EXECUTION',
                    message: 'compensation execution failed',
                }),
                world,
            });
        }
    }

    return Object.freeze({
        status: 'completed' as const,
        semanticRisk,
        compensations: Object.freeze([...compensations]),
        world,
    });
};
