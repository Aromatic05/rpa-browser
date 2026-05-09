import type { ResolveHint, StepResolve } from './types';

const normalize = (value: string | undefined): string => (value || '').trim().toLowerCase();
const hasText = (value: string | undefined): boolean => normalize(value).length > 0;

const isMeaningfulLocatorCandidate = (
    candidate: NonNullable<NonNullable<ResolveHint['raw']>['locatorCandidates']>[number],
): boolean => {
    if (!candidate || typeof candidate !== 'object') {return false;}
    if (candidate.kind === 'css') {return hasText(candidate.selector);}
    if (candidate.kind === 'testid') {return hasText(candidate.testId);}
    if (candidate.kind === 'role') {return hasText(candidate.role) || hasText(candidate.name);}
    if (candidate.kind === 'text' || candidate.kind === 'label' || candidate.kind === 'placeholder') {return hasText(candidate.text);}
    if (candidate.kind === 'attr') {return hasText(candidate.selector) || hasText(candidate.text) || hasText(candidate.name);}
    return hasText(candidate.selector) || hasText(candidate.testId) || hasText(candidate.role) || hasText(candidate.name) || hasText(candidate.text);
};

export const normalizeResolveHint = (hint?: ResolveHint): ResolveHint | undefined => {
    if (!hint) {return hint;}
    const rawSelector = hint.raw?.selector?.trim();
    const rawCandidates = hint.raw?.locatorCandidates || [];
    const deduped = [] as NonNullable<NonNullable<ResolveHint['raw']>['locatorCandidates']>;
    const seen = new Set<string>();
    for (const candidate of rawCandidates) {
        if (!isMeaningfulLocatorCandidate(candidate)) {continue;}
        if (candidate.kind === 'css' && rawSelector && normalize(candidate.selector) === normalize(rawSelector)) {
            continue;
        }
        const key = [
            normalize(candidate.kind),
            normalize(candidate.selector),
            normalize(candidate.testId),
            normalize(candidate.role),
            normalize(candidate.name),
            normalize(candidate.text),
            candidate.exact ? '1' : '0',
        ].join('|');
        if (seen.has(key)) {continue;}
        seen.add(key);
        deduped.push({
            ...candidate,
            selector: candidate.selector?.trim(),
            testId: candidate.testId?.trim(),
            role: candidate.role?.trim(),
            name: candidate.name?.trim(),
            text: candidate.text?.trim(),
        });
    }
    return {
        ...hint,
        raw: hint.raw
            ? {
                  ...hint.raw,
                  selector: rawSelector,
                  locatorCandidates: deduped.length ? deduped : undefined,
              }
            : hint.raw,
    };
};

export const normalizeStepResolve = (resolve?: StepResolve): StepResolve | undefined => {
    if (!resolve) {return resolve;}
    return {
        ...resolve,
        hint: normalizeResolveHint(resolve.hint),
    };
};

const hasUsableHint = (hint?: ResolveHint): boolean => {
    if (!hint) {return false;}
    const hasRawLocatorCandidate = (hint.raw?.locatorCandidates || []).some((candidate) =>
        Boolean(
            (candidate.kind === 'css' && candidate.selector)
                || (candidate.kind === 'testid' && candidate.testId)
                || (candidate.kind === 'role' && (candidate.role || candidate.name))
                || (candidate.kind === 'text' && candidate.text)
                || (candidate.kind === 'placeholder' && candidate.text)
                || (candidate.kind === 'label' && candidate.text)
                || (candidate.kind === 'attr' && (candidate.selector || candidate.text || candidate.name))
        ));
    return Boolean(
        hint.target?.nodeId
            || hint.target?.primaryDomId
            || (hint.target?.sourceDomIds && hint.target.sourceDomIds.length > 0)
            || hint.raw?.selector
            || hint.locator?.direct?.query
            || hint.locator?.direct?.fallback
            || hasRawLocatorCandidate
            || hint.entity?.businessTag
            || hint.entity?.fieldKey
            || hint.entity?.actionIntent,
    );
};

export const isValidStepResolve = (resolve?: StepResolve): boolean => {
    if (!resolve) {return false;}
    return hasUsableHint(normalizeResolveHint(resolve.hint));
};
