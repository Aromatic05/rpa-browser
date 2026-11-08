import type { Locator, Page } from 'playwright';
import type { AtomicTargetInput } from '../../../snapshot';
import type { RunStepsExecutionContext } from '../../run_steps_types';
import type { ResolveHint, StepResolve } from '../types';

type Candidate = NonNullable<NonNullable<ResolveHint['raw']>['locatorCandidates']>[number];

export const recordedActionTarget = (
    page: Page,
    step: {args: {nodeId?: string; selector?: string}; resolve?: StepResolve},
    context?: RunStepsExecutionContext,
): AtomicTargetInput => {
    const hint = step.resolve?.hint;
    const target = {
        nodeId: step.args.nodeId ?? hint?.target?.nodeId,
        selector: step.args.selector ?? hint?.locator?.direct?.query,
    };
    if (!context?.recordingReplay || !hint) {return target;}
    if (!target.nodeId && !target.selector) {target.selector = hint.raw?.selector;}

    const scope = hint.locator?.scope;
    if ((scope && scope.kind !== 'document') || target.selector?.includes('>>')) {return target;}
    const candidates = hint.raw?.locatorCandidates;
    if (!candidates?.length || candidates.length > 16) {return target;}
    const directTestId = hint.target?.attrs?.['data-testid'] ?? hint.target?.attrs?.dataTestId;

    return {
        ...target,
        getReplayCandidates: () => candidates.flatMap((candidate) => {
            const locator = exactCandidateLocator(page, candidate, directTestId);
            return locator ? [{kind: candidate.kind, locator}] : [];
        }),
    };
};

const exactCandidateLocator = (page: Page, candidate: Candidate, directTestId?: string): Locator | undefined => {
    if (candidate.exact === false) {return undefined;}
    switch (candidate.kind) {
        case 'testid':
            // Older recorder events may have collected a test ID from an ancestor.
            return candidate.testId?.trim() && candidate.testId === directTestId
                ? page.getByTestId(candidate.testId)
                : undefined;
        case 'role':
            return candidate.role?.trim() && candidate.name?.trim()
                ? page.getByRole(candidate.role as Parameters<Page['getByRole']>[0], {name: candidate.name, exact: true})
                : undefined;
        case 'label':
            return candidate.text?.trim() ? page.getByLabel(candidate.text, {exact: true}) : undefined;
        case 'placeholder':
            return candidate.text?.trim() ? page.getByPlaceholder(candidate.text, {exact: true}) : undefined;
        default:
            return undefined;
    }
};
