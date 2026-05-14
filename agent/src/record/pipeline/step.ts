import type { Page } from 'playwright';
import crypto from 'crypto';
import { getLogger } from '../../logging/logger';
import type { ResolveHint, ResolvePolicy, Step, StepArgsMap, StepMeta, StepName, StepResolve, StepUnion } from '../../runner/steps/types';
import type { RecorderEvent } from '../capture/recorder';
import { startRecordedStepEnrichment } from '../enhancement/queue';
import { ensureManifest, ensureTabInManifest } from './manifest';
import { fillEventKey, flushPendingChoiceEvents, flushPendingFillEvents, isFillLikeEvent, queuePendingFillEvent, queueRecordingStep } from './pending';
import { getWorkspaceUnsavedToken, isWorkspaceRecordingEnabled, nextRecordingSeq, type RecordingState } from './state';
import { normalizeRecorderEvent } from '../normalizer';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const isTabLifecycleStep = (stepName: StepName): boolean =>
    stepName === 'browser.create_tab' || stepName === 'browser.switch_tab' || stepName === 'browser.close_tab';
const navigateDedupeKey = (recordingToken: string, tabName: string): string => `${recordingToken}::${tabName}`;

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
            { selector: event.selector, kind: 'native_select', values: [event.value] },
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
    const eventRecordSeq = nextRecordingSeq(state, effectiveToken);
    const tabScopedCacheKey = `${effectiveToken}::${tabName}`;
    if (state.replaying.has(tabName)) {return { accepted: false };}
    const pendingFillKey = event.selector ? fillEventKey(tabName, event.selector.trim()) : undefined;
    const buildNormalizeContext = () => ({
        state,
        recordingToken: effectiveToken,
        workspaceName,
        tabName,
        page,
        snapshotCache: state.recordSnapshotCache,
        cacheKey: tabScopedCacheKey,
        createStep,
        buildResolveFromEvent,
    });
    const hooks = {
        toStep,
        enrichRecordedStep,
        startRecordedStepEnrichment: (input: {
            state: RecordingState;
            recordingToken: string;
            stepId: string;
            event: RecorderEvent;
            page?: Page;
            workspaceName: string;
            stepName: StepName;
            ts?: number;
            tabName?: string;
        }) => startRecordedStepEnrichment({ ...input, snapshotCache: state.recordSnapshotCache, cacheKey: tabScopedCacheKey }),
    };
    const removeRecordedStep = (stepId: string) => {
        const list = state.recordings.get(effectiveToken) || [];
        const next = list.filter((item) => item.id !== stepId);
        state.recordings.set(effectiveToken, next);
        const enhancements = state.recordingEnhancements.get(effectiveToken);
        if (enhancements && Object.prototype.hasOwnProperty.call(enhancements, stepId)) {
            delete enhancements[stepId];
        }
    };
    const replaceRecordedStep = (stepId: string, nextStep: StepUnion) => {
        const list = state.recordings.get(effectiveToken) || [];
        const index = list.findIndex((item) => item.id === stepId);
        if (index === -1) {return false;}
        list[index] = nextStep;
        state.recordings.set(effectiveToken, list);
        return true;
    };
    if (event.type === 'navigate') {
        flushPendingChoiceEvents(state, effectiveToken, buildNormalizeContext(), hooks, { workspaceName, page, reason: 'navigate' });
        flushPendingFillEvents(state, effectiveToken, { workspaceName, page }, hooks);
    } else if (event.type === 'click' && event.selector) {
        flushPendingChoiceEvents(state, effectiveToken, buildNormalizeContext(), hooks, { workspaceName, page, reason: 'click' });
        flushPendingFillEvents(state, effectiveToken, { exceptKey: pendingFillKey, workspaceName, page }, hooks);
    }

    if (event.type === 'click') {
        state.lastClickTs.set(effectiveToken, event.ts);
    }

    if (event.type === 'navigate') {
        state.lastNavigateTs.set(navigateDedupeKey(effectiveToken, tabName), event.ts);
        state.recordSnapshotCache.delete(tabScopedCacheKey);
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
        queuePendingFillEvent(state, effectiveToken, tabName, event, eventRecordSeq);
        return { accepted: true };
    }

    let provisionalClickStep: StepUnion | undefined;
    if (event.type === 'click') {
        const provisional = toStep(event);
        if (provisional && provisional.name === 'browser.click') {
            const normalized = enrichRecordedStep(state, effectiveToken, tabName, provisional);
            normalized.meta = { ...(normalized.meta || { source: 'record' }), recordSeq: eventRecordSeq };
            const list = state.recordings.get(effectiveToken) || [];
            list.push(normalized);
            state.recordings.set(effectiveToken, list);
            provisionalClickStep = normalized;
            recordLog('step_queued', {
                stepId: normalized.id,
                stepName: normalized.name,
                ts: normalized.meta?.ts,
                tabName: normalized.meta?.tabName || tabName,
                workspaceName,
                provisional: true,
            });
            startRecordedStepEnrichment({
                state,
                recordingToken: effectiveToken,
                stepId: normalized.id,
                event,
                page,
                snapshotCache: state.recordSnapshotCache,
                cacheKey: tabScopedCacheKey,
                workspaceName,
                stepName: normalized.name,
                ts: normalized.meta?.ts,
                tabName: normalized.meta?.tabName || tabName,
            });
        }
    }

    let currentEvent = event;
    for (let round = 0; round < 3; round += 1) {
        recordLog('record_normalizer_enter', {
            workspaceName,
            tabName,
            hasPage: Boolean(page),
            eventType: currentEvent.type,
            selector: currentEvent.selector,
            ts: currentEvent.ts,
        });
        const normalizedEvent = await normalizeRecorderEvent(buildNormalizeContext(), currentEvent);
        recordLog('record_normalizer_result', {
            status: normalizedEvent.status,
            reason: normalizedEvent.status === 'pass' ? 'pass' : undefined,
            stepName: normalizedEvent.status === 'handled' ? normalizedEvent.step.name : undefined,
            selector: currentEvent.selector,
            valuesLength: normalizedEvent.status === 'handled' && Array.isArray((normalizedEvent.step.args as any).values)
                ? (normalizedEvent.step.args as any).values.length
                : undefined,
        });
        if (normalizedEvent.status === 'pending') {
            if (provisionalClickStep) {
                removeRecordedStep(provisionalClickStep.id);
            }
            return { accepted: true };
        }
        if (normalizedEvent.status === 'handled') {
            if (provisionalClickStep && normalizedEvent.step.name === 'browser.click') {
                const merged = enrichRecordedStep(
                    state,
                    effectiveToken,
                    tabName,
                    {
                        ...normalizedEvent.step,
                        id: provisionalClickStep.id,
                    } as StepUnion,
                );
                merged.meta = { ...(merged.meta || { source: 'record' }), recordSeq: eventRecordSeq };
                replaceRecordedStep(provisionalClickStep.id, merged);
                recordLog('step_updated', {
                    stepId: merged.id,
                    stepName: merged.name,
                    ts: merged.meta?.ts,
                    tabName: merged.meta?.tabName || tabName,
                    workspaceName,
                });
                if (normalizedEvent.continueCurrentEvent) {
                    provisionalClickStep = undefined;
                    continue;
                }
                return { accepted: true };
            }
            if (provisionalClickStep) {
                removeRecordedStep(provisionalClickStep.id);
                provisionalClickStep = undefined;
            }
            queueRecordingStep(
                state,
                effectiveToken,
                tabName,
                {
                    ...normalizedEvent.step,
                    meta: { ...(normalizedEvent.step.meta || { source: 'record' }), recordSeq: eventRecordSeq },
                } as StepUnion,
                normalizedEvent.enhancementEvent,
                hooks,
                { workspaceName, page },
            );
            recordLog('step_queued', {
                stepId: normalizedEvent.step.id,
                stepName: normalizedEvent.step.name,
                ts: normalizedEvent.step.meta?.ts,
                tabName: normalizedEvent.step.meta?.tabName || tabName,
                workspaceName,
            });
            if (normalizedEvent.continueCurrentEvent) {
                continue;
            }
            return { accepted: true };
        }
        break;
    }

    if (provisionalClickStep) {
        return { accepted: true };
    }

    const step = toStep(currentEvent);
    if (!step) {return { accepted: false };}
    step.meta = { ...(step.meta || { source: 'record' }), recordSeq: eventRecordSeq };
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
        event: currentEvent,
        page,
        snapshotCache: state.recordSnapshotCache,
        cacheKey: tabScopedCacheKey,
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
    const tabScopedCacheKey = `${effectiveToken}::${tabName}`;
    if (state.replaying.has(tabName) || state.replaying.has(effectiveToken)) {return { accepted: false };}
    if (options?.flushPendingFill !== false) {
        const hooks = {
            toStep,
            enrichRecordedStep,
            startRecordedStepEnrichment: (input: {
                state: RecordingState;
                recordingToken: string;
                stepId: string;
                event: RecorderEvent;
                page?: Page;
                workspaceName: string;
                stepName: StepName;
                ts?: number;
                tabName?: string;
            }) => startRecordedStepEnrichment({ ...input, snapshotCache: state.recordSnapshotCache, cacheKey: tabScopedCacheKey }),
        };
        flushPendingChoiceEvents(state, effectiveToken, {
            state,
            recordingToken: effectiveToken,
            workspaceName,
            tabName,
            snapshotCache: state.recordSnapshotCache,
            cacheKey: tabScopedCacheKey,
            createStep,
            buildResolveFromEvent,
        }, hooks, { workspaceName, reason: 'append_step' });
        flushPendingFillEvents(state, effectiveToken, { workspaceName }, hooks);
    }

    const ts = step.meta?.ts ?? Date.now();
    const recordSeq = typeof step.meta?.recordSeq === 'number' ? step.meta.recordSeq : nextRecordingSeq(state, effectiveToken);
    const normalized = enrichRecordedStep(state, effectiveToken, tabName, {
        ...step,
        meta: {
            ...step.meta,
            source: step.meta?.source ?? 'record',
            ts,
            recordSeq,
            tabName: step.meta?.tabName || tabName,
        },
    });

    if (normalized.name === 'browser.click') {
        state.lastClickTs.set(effectiveToken, ts);
    }
    if (normalized.name === 'browser.goto') {
        const stepTabName = normalized.meta?.tabName || tabName;
        const dedupeKey = navigateDedupeKey(effectiveToken, stepTabName);
        const last = state.lastNavigateTs.get(dedupeKey) || 0;
        if (options?.updateNavigateDedupe !== false) {
            if (ts - last < navDedupeWindowMs) {return { accepted: false };}
            state.lastNavigateTs.set(dedupeKey, ts);
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
