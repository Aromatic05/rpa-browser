import type {DslEffectDescriptor} from '../../../../automation/dsl/debug/contracts';
import type {DebugEffectSemanticRisk} from './contracts';

export const classifyEffectSemanticRisk = (
    effect: DslEffectDescriptor,
): DebugEffectSemanticRisk => {
    if (effect.semantics.reversibility === 'irreversible') {return 'irreversible';}
    if (effect.semantics.reversibility === 'reversible') {return 'reversible';}
    if (effect.semantics.reversibility === 'compensatable') {return 'compensatable';}
    return 'unknown';
};
