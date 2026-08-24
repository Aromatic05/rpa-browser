import type {EffectDeclaration, EffectReversibility, EffectSemantics} from './contracts';

const REVERSIBILITIES = new Set<EffectReversibility>([
    'unknown',
    'reversible',
    'compensatable',
    'irreversible',
]);

export const isEffectReversibility = (value: unknown): value is EffectReversibility =>
    typeof value === 'string' && REVERSIBILITIES.has(value as EffectReversibility);

export const readEffectDeclaration = (value: unknown): EffectDeclaration | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return undefined;}
    const reversibility = (value as Record<string, unknown>).reversibility;
    return isEffectReversibility(reversibility) ? Object.freeze({reversibility}) : undefined;
};

export const UNKNOWN_EFFECT_SEMANTICS: EffectSemantics = Object.freeze({
    reversibility: 'unknown',
});
