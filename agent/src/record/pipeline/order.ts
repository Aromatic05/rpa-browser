import type { StepUnion } from '../../runner/steps/types';
import { getLogger } from '../../logging/logger';

const isTabLifecycleStep = (stepName: StepName): boolean =>
    stepName === 'browser.create_tab' || stepName === 'browser.switch_tab' || stepName === 'browser.close_tab';

export const normalizeRecordingStepOrder = (steps: StepUnion[], _navDedupeWindowMs: number): StepUnion[] => {
    const indexed = steps.map((step, index) => ({ step, index }));
    const lifecycleGotoIds = new Set<string>();
    for (let index = 1; index < steps.length; index += 1) {
        const step = steps[index];
        const previous = steps[index - 1];
        if (step.name !== 'browser.goto') {continue;}
        if (!isTabLifecycleStep(previous.name)) {continue;}
        if (step.meta?.tabName && previous.meta?.tabName && step.meta.tabName !== previous.meta.tabName) {continue;}
        lifecycleGotoIds.add(step.id);
    }
    const isLifecycleBarrier = (step: StepUnion): boolean =>
        isTabLifecycleStep(step.name) || lifecycleGotoIds.has(step.id);
    const compare = (a: (typeof indexed)[number], b: (typeof indexed)[number]): number => {
        const aSeq = a.step.meta?.recordSeq;
        const bSeq = b.step.meta?.recordSeq;
        if (typeof aSeq === 'number' && typeof bSeq === 'number' && aSeq !== bSeq) {
            return aSeq - bSeq;
        }
        if (typeof aSeq === 'number' && typeof bSeq !== 'number') {return -1;}
        if (typeof aSeq !== 'number' && typeof bSeq === 'number') {return 1;}
        if (isLifecycleBarrier(a.step) || isLifecycleBarrier(b.step)) {
            return a.index - b.index;
        }
        const aTs = a.step.meta?.ts;
        const bTs = b.step.meta?.ts;
        const aTab = a.step.meta?.tabName;
        const bTab = b.step.meta?.tabName;
        if (typeof aTs === 'number' && typeof bTs === 'number' && aTs !== bTs) {
            return aTs - bTs;
        }
        if (typeof aTs === 'number' && typeof bTs !== 'number') {return -1;}
        if (typeof aTs !== 'number' && typeof bTs === 'number') {return 1;}
        return a.index - b.index;
    };
    return indexed.sort(compare).map((item) => item.step);
};

export const insertRecordingStepByRecordedTs = (steps: StepUnion[], step: StepUnion): number => {
    const recordedTs = step.meta?.ts;
    if (typeof recordedTs !== 'number') {
        steps.push(step);
        return steps.length - 1;
    }

    let insertIndex = steps.length;
    for (let index = 0; index < steps.length; index += 1) {
        const currentTs = steps[index].meta?.ts;
        if (typeof currentTs !== 'number') {continue;}
        if (currentTs > recordedTs) {
            insertIndex = index;
            break;
        }
    }

    steps.splice(insertIndex, 0, step);
    getLogger('record').debug('record_step_insert_order', {
        stepId: step.id,
        stepName: step.name,
        recordedTs,
        insertIndex,
    });
    return insertIndex;
};
