import type { ResolveHint, StepResolve } from './types';

const hasUsableHint = (hint?: ResolveHint): boolean => {
    if (!hint) {return false;}
    const hasRawLocatorCandidate = (hint.raw?.locatorCandidates || []).some((candidate) =>
        Boolean(
            (candidate.kind === 'css' && candidate.selector)
                || (candidate.kind === 'testid' && candidate.testId)
                || (candidate.kind === 'role' && (candidate.role || candidate.name))
                || (candidate.kind === 'text' && candidate.text)
                || (candidate.kind === 'placeholder' && candidate.text),
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
    return hasUsableHint(resolve.hint);
};
