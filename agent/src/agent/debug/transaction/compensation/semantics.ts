import type {DslEffectDescriptor} from '../../../../dsl/debug/contracts';
import type {DebugEffectSemanticRisk} from './contracts';

export const classifyEffectSemanticRisk = (
    _effect: DslEffectDescriptor,
): DebugEffectSemanticRisk => 'unknown';
