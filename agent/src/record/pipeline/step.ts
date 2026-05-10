import type { Page } from 'playwright';
import crypto from 'crypto';
import { getLogger } from '../../logging/logger';
import type { ResolveHint, ResolvePolicy, Step, StepArgsMap, StepMeta, StepName, StepResolve, StepUnion } from '../../runner/steps/types';
import type { RecorderEvent } from '../capture/recorder';
import { startRecordedStepEnrichment } from '../enhancement/queue';
import { ensureManifest, ensureTabInManifest } from './manifest';
import { fillEventKey, flushPendingFillEvents, isFillLikeEvent, queuePendingFillEvent } from './pending';
import { getWorkspaceUnsavedToken, isWorkspaceRecordingEnabled, type RecordingState } from './state';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const isTabLifecycleStep = (stepName: StepName): boolean =>
    stepName === 'browser.create_tab' || stepName === 'browser.switch_tab' || stepName === 'browser.close_tab';

export const createStep = <TName extends StepName>(
    name: TName,
    args: StepArgsMap[TName],
    ts: number,
    metaExtra?: Partial<Pick<StepMeta, 'workspaceName' | 'tabName' | 'urlAtRecord'>>,
    resolve?: StepResolve,
): Step<TName> => ({
    id: crypto.randomUUID(),
    name,
    args,
    meta: { source: 'record', ts, ...metaExtra },
    resolve,
});

export const buildResolveFromEvent = (event: RecorderEvent): StepResolve | undefined => {
    const hint: ResolveHint = {
        target: {
            role: event.a11yHint?.role,
            name: event.a11yHint?.name,
            text: event.a11yHint?.text,
        },
        raw: {
            selector: event.selector,
            locatorCandidates: event.locatorCandidates?.map((item) => ({ ...item })),
            scopeHint: event.scopeHint || undefined,
            targetHint: event.targetHint,
        },
    };
    const policy: ResolvePolicy = {
        requireVisible: true,
    };
    if (!hint.target?.role && !hint.target?.name && !hint.target?.text && !hint.raw?.selector && !(hint.raw?.locatorCandidates || []).length) {
        return undefined;
    }
    return { hint, policy };
};

export const toStep = (event: RecorderEvent): StepUnion | null => {
    if (event.type === 'navigate' && event.url) {
        return createStep('browser.goto', { url: event.url }, event.ts, {
            tabName: event.tabName,
            urlAtRecord: event.url,
        });
    }
    if (event.type === 'click' && (event.selector || event.a11yHint)) {
        return createStep(
            'browser.click',
            { selector: event.selector },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'input' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'change' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'date' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'select' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.select_option',
            { selector: event.selector, values: [event.value] },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'check' && (event.selector || event.a11yHint)) {
        return createStep(
            'browser.click',
            { selector: event.selector },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'keydown' && event.key) {
        return createStep(
            'browser.press_key',
            {
                key: event.key,
                selector: event.selector || undefined,
            },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'paste' && event.selector && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'scroll' && typeof event.scrollY === 'number') {
        const delta = event.scrollY;
        if (delta === 0) {return null;}
        return createStep(
            'browser.scroll',
            { direction: delta > 0 ? 'down' : 'up', amount: Math.abs(delta) },
            event.ts,
            { tabName: event.tabName },
        );
    }
    return null;
};

export const enrichRecordedStep = (
    state: RecordingState,
    recordingToken: string,
    sourceTabName: string,
    step: StepUnion,
): StepUnion => {
    const ts = step.meta?.ts ?? Date.now();
    const manifest = ensureManifest(state.recordingManifests, recordingToken);
    if (step.meta?.workspaceName && !manifest.workspaceName) {
        manifest.workspaceName = step.meta.workspaceName;
    }
    const stepTabName = step.meta?.tabName || sourceTabName;
    const args = step.args as unknown;
    const gotoUrl = isRecord(args) && typeof args.url === 'string' ? args.url : undefined;
    const stepUrl =
        step.meta?.urlAtRecord ||
        (step.name === 'browser.goto' ? gotoUrl : undefined) ||
        undefined;
    const tab = ensureTabInManifest(manifest, stepTabName, {
        url: stepUrl || undefined,
        at: ts,
    });
    if (!manifest.entryTabRef) {manifest.entryTabRef = tab.tabRef;}
    if (!manifest.entryUrl && stepUrl) {manifest.entryUrl = stepUrl;}
    const lifecycleStep = isTabLifecycleStep(step.name);
    return {
        ...step,
        meta: {
            ...step.meta,
            source: step.meta?.source ?? 'record',
            ts,
            tabName: stepTabName,
            ...(lifecycleStep ? {} : { urlAtRecord: step.meta?.urlAtRecord || stepUrl || undefined }),
        },
    };
};

export const appendWorkspaceRecordingEvent = async (
    state: RecordingState,
    workspaceName: string,
    tabName: string,
    event: RecorderEvent,
    navDedupeWindowMs: number,
    page?: Page,
): Promise<{ accepted: boolean }> => {
    const recordLog = getLogger('record');
    if (!isWorkspaceRecordingEnabled(state, workspaceName)) {return { accepted: false };}
    const effectiveToken = getWorkspaceUnsavedToken(state, workspaceName);
    if (state.replaying.has(tabName)) {return { accepted: false };}
    const pendingFillKey = event.selector ? fillEventKey(tabName, event.selector.trim()) : undefined;
    if (event.type === 'navigate') {
        flushPendingFillEvents(state, effectiveToken, { workspaceName, page }, { toStep, enrichRecordedStep, startRecordedStepEnrichment: (input) => startRecordedStepEnrichment({ ...input, snapshotCache: state.recordSnapshotCache, cacheKey: effectiveToken }) });
    } else if (event.type === 'click' && event.selector) {
        flushPendingFillEvents(state, effectiveToken, { exceptKey: pendingFillKey, workspaceName, page }, { toStep, enrichRecordedStep, startRecordedStepEnrichment: (input) => startRecordedStepEnrichment({ ...input, snapshotCache: state.recordSnapshotCache, cacheKey: effectiveToken }) });
    }

    if (event.type === 'click') {
        state.lastClickTs.set(effectiveToken, event.ts);
    }

    if (event.type === 'navigate') {
        const last = state.lastNavigateTs.get(effectiveToken) || 0;
        if (event.ts - last < navDedupeWindowMs) {
            return { accepted: false };
        }
        state.lastNavigateTs.set(effectiveToken, event.ts);
        state.recordSnapshotCache.delete(effectiveToken);
    }

    if (event.type === 'scroll' && typeof event.scrollY === 'number') {
        const last = state.lastScrollY.get(effectiveToken) ?? 0;
        const delta = event.scrollY - last;
        state.lastScrollY.set(effectiveToken, event.scrollY);
        event.scrollY = delta;
    }

    if (event.value && event.value !== '***') {
        const value = event.value.trim();
        if (value.length > 200) {
            event.value = '***';
        } else if (value.length > 80) {
            event.value = value.slice(0, 80);
        } else {
            event.value = value;
        }
    }

    if (isFillLikeEvent(event)) {
        queuePendingFillEvent(state, effectiveToken, tabName, event);
        return { accepted: true };
    }

    const step = toStep(event);
    if (!step) {return { accepted: false };}
    const normalized = enrichRecordedStep(state, effectiveToken, tabName, step);
    const list = state.recordings.get(effectiveToken) || [];
    list.push(normalized);
    state.recordings.set(effectiveToken, list);
    recordLog('step_queued', {
        stepId: normalized.id,
        stepName: normalized.name,
        ts: normalized.meta?.ts,
        tabName: normalized.meta?.tabName || tabName,
        workspaceName,
    });
    startRecordedStepEnrichment({
        state,
        recordingToken: effectiveToken,
        stepId: normalized.id,
        event,
        page,
        snapshotCache: state.recordSnapshotCache,
        cacheKey: effectiveToken,
        workspaceName,
        stepName: normalized.name,
        ts: normalized.meta?.ts,
        tabName: normalized.meta?.tabName || tabName,
    });
    return { accepted: true };
};

export const appendWorkspaceRecordingStep = (
    state: RecordingState,
    workspaceName: string,
    tabName: string,
    step: StepUnion,
    navDedupeWindowMs: number,
    options?: { flushPendingFill?: boolean; updateNavigateDedupe?: boolean },
): { accepted: boolean } => {
    const recordLog = getLogger('record');
    if (!isWorkspaceRecordingEnabled(state, workspaceName)) {return { accepted: false };}
    const effectiveToken = getWorkspaceUnsavedToken(state, workspaceName);
    if (state.replaying.has(tabName) || state.replaying.has(effectiveToken)) {return { accepted: false };}
    if (options?.flushPendingFill !== false) {
        flushPendingFillEvents(state, effectiveToken, { workspaceName }, { toStep, enrichRecordedStep, startRecordedStepEnrichment: (input) => startRecordedStepEnrichment({ ...input, snapshotCache: state.recordSnapshotCache, cacheKey: effectiveToken }) });
    }

    const ts = step.meta?.ts ?? Date.now();
    const normalized = enrichRecordedStep(state, effectiveToken, tabName, {
        ...step,
        meta: {
            ...step.meta,
            source: step.meta?.source ?? 'record',
            ts,
            tabName: step.meta?.tabName || tabName,
        },
    });

    if (normalized.name === 'browser.click') {
        state.lastClickTs.set(effectiveToken, ts);
    }
    if (normalized.name === 'browser.goto') {
        const last = state.lastNavigateTs.get(effectiveToken) || 0;
        if (options?.updateNavigateDedupe !== false) {
            if (ts - last < navDedupeWindowMs) {return { accepted: false };}
            state.lastNavigateTs.set(effectiveToken, ts);
        }
    }

    const list = state.recordings.get(effectiveToken) || [];
    list.push(normalized);
    state.recordings.set(effectiveToken, list);
    recordLog('step_queued', {
        stepId: normalized.id,
        stepName: normalized.name,
        ts,
        tabName: normalized.meta?.tabName || tabName,
        workspaceName,
    });
    return { accepted: true };
};
