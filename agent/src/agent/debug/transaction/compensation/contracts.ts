import type {StepArgsMap, StepResult, StepUnion} from '../../../../runner/steps/types';

export type DebugCompensationPort = {
    execute: (step: StepUnion) => Promise<StepResult>;
};

export type DebugEffectSemanticRisk = 'unknown' | 'compensatable' | 'irreversible';

export type DebugPhysicalCompensationPlan =
    | Readonly<{
        status: 'available';
        semanticRisk: DebugEffectSemanticRisk;
        capability: 'restore_value';
        effectSequence: number;
        operation: Readonly<{
            name: 'browser.fill';
            args: StepArgsMap['browser.fill'];
        }>;
    }>
    | Readonly<{
        status: 'unavailable';
        semanticRisk: DebugEffectSemanticRisk;
        reason: 'unsupported_effect' | 'explicit_target_required' | 'previous_value_unavailable';
        effectSequence: number;
    }>;
