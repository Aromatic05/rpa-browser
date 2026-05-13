import crypto from 'node:crypto';
import type { RecordingState } from './recording';
import { appendWorkspaceRecordingStep, getWorkspaceUnsavedToken } from './recording';
import type { StepUnion } from '../runner/steps/types';

type TabLifecycleInput = {
    workspaceName: string;
    tabName: string;
    tabRef: string;
    urlAtRecord?: string;
    at?: number;
    navDedupeWindowMs: number;
};

type FirstPageUrlInput = TabLifecycleInput & {
    url: string;
};

const getRecordedSteps = (state: RecordingState, workspaceName: string): StepUnion[] => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    return state.recordings.get(token) || [];
};

const isSameTab = (step: StepUnion, tabRef: string): boolean => {
    const args = (step.args || {}) as Record<string, unknown>;
    const stepTabName = typeof args.tabName === 'string' ? args.tabName : undefined;
    const metaTabName = typeof step.meta?.tabName === 'string' ? step.meta.tabName : undefined;
    return stepTabName === tabRef || metaTabName === tabRef;
};

const shouldSkipCreated = (steps: StepUnion[], tabRef: string): boolean => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
        const step = steps[i];
        if (!isSameTab(step, tabRef)) {continue;}
        if (step.name === 'browser.close_tab') {return false;}
        if (step.name === 'browser.create_tab') {return true;}
        return false;
    }
    return false;
};

const shouldSkipClosed = (steps: StepUnion[], tabRef: string): boolean => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
        const step = steps[i];
        if (!isSameTab(step, tabRef)) {continue;}
        return step.name === 'browser.close_tab';
    }
    return false;
};

const shouldSkipActivated = (steps: StepUnion[], tabRef: string): boolean => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
        const step = steps[i];
        if (!isSameTab(step, tabRef)) {continue;}
        if (step.name === 'browser.goto') {continue;}
        return step.name === 'browser.switch_tab';
    }
    return false;
};

const isOrdinaryPageUrl = (url: string): boolean =>
    url.startsWith('http://') || url.startsWith('https://');

const hasCreatedTab = (steps: StepUnion[], tabRef: string): boolean => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
        const step = steps[i];
        if (!isSameTab(step, tabRef)) {continue;}
        if (step.name === 'browser.close_tab') {return false;}
        if (step.name === 'browser.create_tab') {return true;}
    }
    return false;
};

const shouldSkipFirstPageGoto = (steps: StepUnion[], tabRef: string): boolean => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
        const step = steps[i];
        if (!isSameTab(step, tabRef)) {continue;}
        if (step.name === 'browser.close_tab') {return false;}
        if (step.name === 'browser.goto') {
            return true;
        }
        if (step.name === 'browser.create_tab') {return false;}
    }
    return false;
};

export const recordTabCreated = (state: RecordingState, input: TabLifecycleInput): { accepted: boolean } => {
    const steps = getRecordedSteps(state, input.workspaceName);
    if (shouldSkipCreated(steps, input.tabRef)) {return { accepted: false };}
    const ts = input.at ?? Date.now();
    return appendWorkspaceRecordingStep(
        state,
        input.workspaceName,
        input.tabName,
        {
            id: crypto.randomUUID(),
            name: 'browser.create_tab',
            args: { tabName: input.tabName },
            meta: {
                source: 'record',
                ts,
                workspaceName: input.workspaceName,
                tabName: input.tabName,
            },
        },
        input.navDedupeWindowMs,
        { flushPendingFill: false, updateNavigateDedupe: false },
    );
};

export const recordFirstTabPageUrl = (state: RecordingState, input: FirstPageUrlInput): { accepted: boolean } => {
    if (!isOrdinaryPageUrl(input.url)) {return { accepted: false };}
    const steps = getRecordedSteps(state, input.workspaceName);
    if (!hasCreatedTab(steps, input.tabRef) || shouldSkipFirstPageGoto(steps, input.tabRef)) {
        return { accepted: false };
    }
    const ts = input.at ?? Date.now();
    return appendWorkspaceRecordingStep(
        state,
        input.workspaceName,
        input.tabName,
        {
            id: crypto.randomUUID(),
            name: 'browser.goto',
            args: { url: input.url },
            meta: {
                source: 'record',
                ts,
                workspaceName: input.workspaceName,
                tabName: input.tabName,
                urlAtRecord: input.url,
            },
        },
        input.navDedupeWindowMs,
        { flushPendingFill: false, updateNavigateDedupe: false },
    );
};

export const recordTabNavigation = (state: RecordingState, input: FirstPageUrlInput): { accepted: boolean } => {
    if (!isOrdinaryPageUrl(input.url)) {return { accepted: false };}
    const steps = getRecordedSteps(state, input.workspaceName);
    for (let i = steps.length - 1; i >= 0; i -= 1) {
        const step = steps[i];
        if (!isSameTab(step, input.tabRef)) {continue;}
        if (step.name === 'browser.close_tab') {return { accepted: false };}
        if (step.name === 'browser.goto') {
            const args = (step.args || {}) as Record<string, unknown>;
            if (typeof args.url === 'string' && args.url === input.url) {return { accepted: false };}
            break;
        }
        break;
    }
    const ts = input.at ?? Date.now();
    return appendWorkspaceRecordingStep(
        state,
        input.workspaceName,
        input.tabName,
        {
            id: crypto.randomUUID(),
            name: 'browser.goto',
            args: { url: input.url },
            meta: {
                source: 'record',
                ts,
                workspaceName: input.workspaceName,
                tabName: input.tabName,
                urlAtRecord: input.url,
            },
        },
        input.navDedupeWindowMs,
        { flushPendingFill: false, updateNavigateDedupe: false },
    );
};

export const recordTabActivated = (state: RecordingState, input: TabLifecycleInput): { accepted: boolean } => {
    const steps = getRecordedSteps(state, input.workspaceName);
    if (shouldSkipActivated(steps, input.tabRef)) {return { accepted: false };}
    const ts = input.at ?? Date.now();
    return appendWorkspaceRecordingStep(
        state,
        input.workspaceName,
        input.tabName,
        {
            id: crypto.randomUUID(),
            name: 'browser.switch_tab',
            args: { tabName: input.tabName },
            meta: {
                source: 'record',
                ts,
                workspaceName: input.workspaceName,
                tabName: input.tabName,
            },
        },
        input.navDedupeWindowMs,
    );
};

export const recordTabClosed = (state: RecordingState, input: TabLifecycleInput): { accepted: boolean } => {
    const steps = getRecordedSteps(state, input.workspaceName);
    if (shouldSkipClosed(steps, input.tabRef)) {return { accepted: false };}
    const ts = input.at ?? Date.now();
    return appendWorkspaceRecordingStep(
        state,
        input.workspaceName,
        input.tabName,
        {
            id: crypto.randomUUID(),
            name: 'browser.close_tab',
            args: { tabName: input.tabName },
            meta: {
                source: 'record',
                ts,
                workspaceName: input.workspaceName,
                tabName: input.tabName,
            },
        },
        input.navDedupeWindowMs,
    );
};
