import type { ResolveHint, StepResolve } from './types';

const hasUsableHint = (hint?: ResolveHint): boolean => {
    if (!hint) {return false;}
    return Boolean(
        hint.target?.nodeId
            || hint.target?.primaryDomId
            || hint.raw?.selector
            || hint.locator?.direct?.query
            || hint.entity?.businessTag
            || hint.entity?.fieldKey
            || hint.entity?.actionIntent,
    );
};

export const isValidStepResolve = (resolve?: StepResolve): boolean => {
    if (!resolve) {return false;}
    return hasUsableHint(resolve.hint);
};

