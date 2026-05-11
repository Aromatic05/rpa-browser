import type { StepUnion } from '../../runner/steps/types';
import { getLogger } from '../../logging/logger';
import type { RecorderEvent } from '../capture/recorder';
import {
    readControlOptionByNodeId,
    readOptionRecordedValue,
    readSelectedValuesFromControl,
    resolveRecordTargetBinding,
} from '../pipeline/target_binding';
import type {
    PendingCheckboxGroupSession,
    PendingChoiceSession,
    PendingCustomSelectSession,
    PendingSuppressedClick,
    RecordingState,
} from '../pipeline/state';
import type { SelectOptionKind } from '../../runner/steps/executors/select_option/types';
import type {
    NormalizeContext,
    NormalizeHandledResult,
    RecordNormalizerResult,
} from './types';

const checkboxSessionKey = (
    workspaceName: string,
    tabName: string,
    controlRootNodeId: string,
): string => `${workspaceName}::${tabName}::checkbox_group::${controlRootNodeId}`;

const customSessionKey = (
    workspaceName: string,
    tabName: string,
    controlRootNodeId: string,
): string => `${workspaceName}::${tabName}::custom_select::${controlRootNodeId}`;

const NATIVE_SELECT_CLICK_SUPPRESS_WINDOW_MS = 1200;
const CUSTOM_SELECT_PENDING_WINDOW_MS = 1200;

const normalizeSelector = (selector: string | undefined): string =>
    (selector || '').replace(/\s+/g, ' ').trim();

const isNativeSelectClickEvent = (event: RecorderEvent): boolean =>
    event.type === 'click' && String(event.targetHint || '').trim().toLowerCase() === 'select';

const readExecutableLocatorSelector = (
    binding: { snapshot: { locatorIndex?: Record<string, { direct?: { kind?: string; query?: string; fallback?: string } }> } },
    nodeId: string | undefined,
): string | undefined => {
    if (!nodeId) {return undefined;}
    const direct = binding.snapshot.locatorIndex?.[nodeId]?.direct;
    if (!direct) {return undefined;}
    const selector = direct.kind === 'role' ? direct.fallback : direct.query;
    return normalizeSelector(selector) || undefined;
};

const readControlAnchorSelector = (
    binding: {
        snapshot: { locatorIndex?: Record<string, { direct?: { kind?: string; query?: string; fallback?: string } }> };
        component: { rootNodeId?: string; controlNodeId?: string };
    },
    event: RecorderEvent,
): string | undefined => {
    return readExecutableLocatorSelector(binding, binding.component.rootNodeId)
        || readExecutableLocatorSelector(binding, binding.component.controlNodeId)
        || normalizeSelector(event.selector)
        || event.selector;
};

const hasRoleCandidate = (event: RecorderEvent, role: string): boolean => {
    const expectedRole = role.trim();
    if (!expectedRole) {return false;}

    const candidates = Array.isArray(event.locatorCandidates) ? event.locatorCandidates : [];
    return candidates.some((candidate) =>
        candidate?.kind === 'role' && String(candidate.role || '').trim() === expectedRole);
};

const hasRoleOptionCandidate = (event: RecorderEvent): boolean =>
    hasRoleCandidate(event, 'option');

const readOptionTextFromEvent = (event: RecorderEvent): string | undefined => {
    const fromHintName = normalizeSelector(event.a11yHint?.name);
    if (fromHintName) {return fromHintName;}

    const fromHintText = normalizeSelector(event.a11yHint?.text);
    if (fromHintText) {return fromHintText;}

    const candidates = Array.isArray(event.locatorCandidates) ? event.locatorCandidates : [];
    for (const candidate of candidates) {
        if (!candidate || candidate.kind !== 'role') {continue;}
        if (String(candidate.role || '').trim() !== 'option') {continue;}
        const name = normalizeSelector(candidate.name);
        if (name) {return name;}
    }

    for (const candidate of candidates) {
        if (!candidate || candidate.kind !== 'text') {continue;}
        const text = normalizeSelector(candidate.text);
        if (text) {return text;}
    }

    return undefined;
};

const isOptionSemanticEvent = (event: RecorderEvent): boolean => {
    return (event.a11yHint?.role || '').trim() === 'option' || hasRoleOptionCandidate(event);
};

const isComboboxSemanticTriggerEvent = (event: RecorderEvent): boolean => {
    if (event.type !== 'click') {return false;}
    if (!normalizeSelector(event.selector)) {return false;}

    const hintRole = String(event.a11yHint?.role || '').trim();
    return hintRole === 'combobox' || hasRoleCandidate(event, 'combobox');
};

const isCustomSelectSemanticOptionEvent = (event: RecorderEvent): boolean => {
    if (event.type !== 'click') {return false;}
    if (!normalizeSelector(event.selector)) {return false;}
    if (!isOptionSemanticEvent(event)) {return false;}
    return Boolean(readOptionTextFromEvent(event));
};

const readChoiceSessions = (state: RecordingState, recordingToken: string): Map<string, PendingChoiceSession> => {
    let sessions = state.pendingChoiceEvents.get(recordingToken);
    if (!sessions) {
        sessions = new Map();
        state.pendingChoiceEvents.set(recordingToken, sessions);
    }
    return sessions;
};

const deleteChoiceSession = (state: RecordingState, recordingToken: string, sessionKey: string): void => {
    const sessions = state.pendingChoiceEvents.get(recordingToken);
    if (!sessions) {return;}
    sessions.delete(sessionKey);
    if (sessions.size === 0) {
        state.pendingChoiceEvents.delete(recordingToken);
    }
};

const readSuppressedClicks = (state: RecordingState, recordingToken: string): PendingSuppressedClick[] => {
    return state.pendingSuppressedClicks.get(recordingToken) || [];
};

const writeSuppressedClicks = (state: RecordingState, recordingToken: string, entries: PendingSuppressedClick[]): void => {
    if (!entries.length) {
        state.pendingSuppressedClicks.delete(recordingToken);
        return;
    }
    state.pendingSuppressedClicks.set(recordingToken, entries);
};

const deletePendingCustomSelectBySelector = (
    state: RecordingState,
    recordingToken: string,
    tabName: string,
    selector: string,
): void => {
    const normalizedSelector = normalizeSelector(selector);
    if (!normalizedSelector) {return;}
    const sessions = state.pendingChoiceEvents.get(recordingToken);
    if (!sessions) {return;}
    for (const session of Array.from(sessions.values())) {
        if (session.kind !== 'custom_select') {continue;}
        if (session.tabName !== tabName) {continue;}
        if (normalizeSelector(session.selector) !== normalizedSelector) {continue;}
        sessions.delete(session.sessionKey);
    }
    if (sessions.size === 0) {
        state.pendingChoiceEvents.delete(recordingToken);
    }
};

const consumeSuppressedNativeSelectClick = (context: NormalizeContext, event: RecorderEvent): boolean => {
    if (event.type !== 'click') {return false;}

    const selector = normalizeSelector(event.selector);
    if (!selector) {return false;}

    const current = readSuppressedClicks(context.state, context.recordingToken);
    const kept: PendingSuppressedClick[] = [];
    let consumed = false;

    for (const item of current) {
        if (event.ts - item.ts > NATIVE_SELECT_CLICK_SUPPRESS_WINDOW_MS) {
            continue;
        }

        if (!consumed && item.tabName === context.tabName && item.selector === selector) {
            consumed = true;
            continue;
        }

        kept.push(item);
    }

    writeSuppressedClicks(context.state, context.recordingToken, kept);
    return consumed;
};

const markSuppressedNativeSelectClick = (context: NormalizeContext, event: RecorderEvent): void => {
    const selector = normalizeSelector(event.selector);
    if (!selector) {return;}

    const entries = readSuppressedClicks(context.state, context.recordingToken)
        .filter((item) => event.ts - item.ts <= NATIVE_SELECT_CLICK_SUPPRESS_WINDOW_MS);

    entries.push({ tabName: context.tabName, selector, ts: event.ts });
    writeSuppressedClicks(context.state, context.recordingToken, entries);
};

const buildSelectOptionStep = (
    context: NormalizeContext,
    event: RecorderEvent,
    kind: SelectOptionKind,
    values: string[],
    selector?: string,
): NormalizeHandledResult => {
    const step = context.createStep(
        'browser.select_option',
        {
            selector: selector ?? event.selector,
            kind,
            values,
        },
        event.ts,
        { tabName: event.tabName },
        context.buildResolveFromEvent(event),
    );

    return {
        status: 'handled',
        step,
        enhancementEvent: event,
    };
};

const buildReleasedTriggerClickStep = (context: NormalizeContext, triggerEvent: RecorderEvent): StepUnion => {
    return context.createStep(
        'browser.click',
        { selector: triggerEvent.selector },
        triggerEvent.ts,
        { tabName: triggerEvent.tabName },
        context.buildResolveFromEvent(triggerEvent),
    );
};

export const flushPendingChoiceEvents = (input: {
    state: RecordingState;
    recordingToken: string;
    workspaceName: string;
    tabName: string;
    reason: 'navigate' | 'click' | 'stop' | 'save' | 'append_step';
    context: NormalizeContext;
}): Array<{ step: StepUnion; event: RecorderEvent }> => {
    const sessions = input.state.pendingChoiceEvents.get(input.recordingToken);
    if (!sessions || sessions.size === 0) {return [];}

    const emitted: Array<{ step: StepUnion; event: RecorderEvent }> = [];
    const ordered = Array.from(sessions.values()).sort((a, b) => a.ts - b.ts);

    for (const session of ordered) {
        if (session.kind === 'checkbox_group') {
            const step = input.context.createStep(
                'browser.select_option',
                {
                    selector: session.selector,
                    kind: 'checkbox_group',
                    values: [...session.values],
                },
                session.lastEvent.ts,
                { tabName: session.tabName },
                session.resolve,
            );

            emitted.push({ step, event: session.lastEvent });
            deleteChoiceSession(input.state, input.recordingToken, session.sessionKey);
            continue;
        }

        if (session.kind === 'custom_select' && input.reason === 'navigate') {
            deleteChoiceSession(input.state, input.recordingToken, session.sessionKey);
            continue;
        }

        if (session.kind === 'custom_select' && input.reason === 'click') {
            continue;
        }

        if (session.kind === 'custom_select') {
            const step = input.context.createStep(
                'browser.click',
                { selector: session.selector },
                session.triggerEvent.ts,
                { tabName: session.tabName },
                session.resolve,
            );

            emitted.push({ step, event: session.triggerEvent });
            deleteChoiceSession(input.state, input.recordingToken, session.sessionKey);
        }
    }

    return emitted;
};

export const normalizeSelectOption = async (
    context: NormalizeContext,
    event: RecorderEvent,
): Promise<RecordNormalizerResult> => {
    const recordLog = getLogger('record');
    const forceFreshSnapshot = event.type === 'check' || event.type === 'select' || event.type === 'click';

    if (consumeSuppressedNativeSelectClick(context, event)) {
        recordLog('record_select_suppress_hit', {
            tabName: context.tabName,
            selector: event.selector,
            eventTs: event.ts,
        });
        recordLog('record_select_option_normalizer', {
            eventType: event.type,
            selector: event.selector,
            result: 'pending',
            reason: 'native_select_suppress_hit',
            values: [],
        });
        return { status: 'pending' };
    }

    if (event.type === 'click') {
        recordLog('record_select_suppress_miss', {
            tabName: context.tabName,
            selector: event.selector,
            reason: 'missing',
        });
    }

    if (isNativeSelectClickEvent(event)) {
        recordLog('record_select_option_normalizer', {
            eventType: event.type,
            selector: event.selector,
            result: 'pending',
            reason: 'native_select_click_absorb',
            values: [],
        });
        return { status: 'pending' };
    }

    if (event.type === 'select' && typeof event.selector === 'string' && event.selector.trim() && typeof event.value === 'string') {
        markSuppressedNativeSelectClick(context, event);
        deletePendingCustomSelectBySelector(context.state, context.recordingToken, context.tabName, event.selector || '');
        recordLog('record_select_suppress_write', {
            tabName: context.tabName,
            selector: event.selector,
            ts: event.ts,
        });
        recordLog('record_select_native_direct', {
            selector: event.selector,
            value: event.value,
            suppressWritten: true,
        });

        const result = buildSelectOptionStep(context, event, 'native_select', [event.value]);
        recordLog('record_select_option_normalizer', {
            eventType: event.type,
            selector: event.selector,
            result: 'handled',
            reason: 'native_select_direct',
            componentKind: 'native_select',
            values: [event.value.slice(0, 32)],
        });
        return result;
    }

    if (event.type === 'click') {
        const sessions = context.state.pendingChoiceEvents.get(context.recordingToken);
        if (sessions && sessions.size > 0) {
            const pendingCustom = Array.from(sessions.values())
                .find((item) => item.kind === 'custom_select') as PendingCustomSelectSession | undefined;

            if (pendingCustom) {
                const clickBinding = await resolveRecordTargetBinding({
                    event,
                    page: context.page,
                    snapshotCache: context.snapshotCache,
                    cacheKey: context.cacheKey,
                    forceFreshSnapshot,
                });

                const sameControl = Boolean(
                    clickBinding
                    && pendingCustom.controlRootNodeId
                    && clickBinding.controlRootNodeId === pendingCustom.controlRootNodeId,
                );
                const keepPendingForOptionSemantic = !sameControl
                    && pendingCustom.tabName === context.tabName
                    && event.ts - pendingCustom.ts <= CUSTOM_SELECT_PENDING_WINDOW_MS
                    && isCustomSelectSemanticOptionEvent(event);

                recordLog('record_select_custom_pending_compare', {
                    tabName: context.tabName,
                    pendingSource: pendingCustom.source || 'bound_trigger',
                    pendingControlRootNodeId: pendingCustom.controlRootNodeId,
                    eventSelector: event.selector,
                    sameControl,
                    keepPendingForOptionSemantic,
                    optionSemantic: isOptionSemanticEvent(event),
                });

                if (!sameControl && !keepPendingForOptionSemantic) {
                    const releasedStep = buildReleasedTriggerClickStep(context, pendingCustom.triggerEvent);
                    deleteChoiceSession(context.state, context.recordingToken, pendingCustom.sessionKey);
                    recordLog('record_select_custom_pending_release', {
                        tabName: context.tabName,
                        reason: 'click_outside_pending',
                        pendingSource: pendingCustom.source || 'bound_trigger',
                        triggerSelector: pendingCustom.triggerEvent.selector,
                        eventSelector: event.selector,
                    });
                    return {
                        status: 'handled',
                        step: releasedStep,
                        enhancementEvent: pendingCustom.triggerEvent,
                        continueCurrentEvent: true,
                    };
                }
            }
        }
    }

    const binding = await resolveRecordTargetBinding({
        event,
        page: context.page,
        snapshotCache: context.snapshotCache,
        cacheKey: context.cacheKey,
        forceFreshSnapshot,
    });

    if (!binding) {
        if (event.type === 'click') {
            const sessions = readChoiceSessions(context.state, context.recordingToken);
            let pendingCustom = Array.from(sessions.values())
                .find((item) => item.kind === 'custom_select') as PendingCustomSelectSession | undefined;

            if (!pendingCustom) {
                const selector = normalizeSelector(event.selector);
                const validSemanticTrigger = event.type === 'click'
                    && Boolean(selector)
                    && isComboboxSemanticTriggerEvent(event)
                    && Boolean(context.tabName);

                if (validSemanticTrigger) {
                    const sessionKey = `${context.workspaceName}::${context.tabName}::custom_select::semantic::${selector}`;
                    const semanticSession: PendingCustomSelectSession = {
                        kind: 'custom_select',
                        source: 'semantic_trigger',
                        sessionKey,
                        controlRootNodeId: `semantic:${selector}`,
                        controlRef: `semantic:${selector}`,
                        workspaceName: context.workspaceName,
                        tabName: context.tabName,
                        selector: event.selector,
                        resolve: context.buildResolveFromEvent(event),
                        triggerEvent: event,
                        ts: event.ts,
                    };

                    sessions.set(sessionKey, semanticSession);
                    recordLog('record_select_custom_semantic_pending_start', {
                        selector: event.selector,
                        tabName: context.tabName,
                        reason: 'binding_missing_combobox_trigger',
                    });
                    recordLog('record_select_option_normalizer', {
                        eventType: event.type,
                        selector: event.selector,
                        result: 'pending',
                        reason: 'custom_trigger_semantic_pending',
                        componentKind: 'custom_select',
                        values: [],
                    });
                    return { status: 'pending' };
                }
            }

            pendingCustom = Array.from(sessions.values())
                .find((item) => item.kind === 'custom_select') as PendingCustomSelectSession | undefined;

            const optionText = readOptionTextFromEvent(event);
            const withinWindow = Boolean(pendingCustom && event.ts - pendingCustom.ts <= CUSTOM_SELECT_PENDING_WINDOW_MS);
            const sameTab = Boolean(pendingCustom && pendingCustom.tabName === context.tabName);
            const semanticOption = isCustomSelectSemanticOptionEvent(event);

            if (pendingCustom && semanticOption && optionText && withinWindow && sameTab) {
                const result = buildSelectOptionStep(context, pendingCustom.triggerEvent, 'custom_select', [optionText]);
                deleteChoiceSession(context.state, context.recordingToken, pendingCustom.sessionKey);
                recordLog('record_select_custom_semantic_pending_consume', {
                    triggerSelector: pendingCustom.triggerEvent.selector,
                    optionSelector: event.selector,
                    optionValue: optionText,
                    tabName: context.tabName,
                });
                recordLog('record_select_option_normalizer', {
                    eventType: event.type,
                    selector: event.selector,
                    result: 'handled',
                    reason: 'custom_option_semantic_pending',
                    componentKind: 'custom_select',
                    controlRootNodeId: pendingCustom.controlRootNodeId,
                    values: [optionText.slice(0, 32)],
                });
                return result;
            }
        }

        recordLog('record_select_option_normalizer', {
            eventType: event.type,
            selector: event.selector,
            result: 'pass',
            reason: 'no_binding',
            values: [],
        });
        return { status: 'pass' };
    }

    if (binding.componentKind === 'native_select') {
        if (event.type === 'click') {
            recordLog('record_select_option_normalizer', {
                eventType: event.type,
                selector: event.selector,
                result: 'pending',
                reason: 'native_select_click_absorb',
                componentKind: binding.componentKind,
                targetNodeId: binding.targetNodeId,
                controlRootNodeId: binding.controlRootNodeId,
                values: [],
            });
            return { status: 'pending' };
        }

        if (event.type !== 'select' || typeof event.value !== 'string') {
            recordLog('record_select_option_normalizer', {
                eventType: event.type,
                selector: event.selector,
                result: 'pass',
                reason: 'native_select_non_select_event',
                componentKind: binding.componentKind,
                targetNodeId: binding.targetNodeId,
                controlRootNodeId: binding.controlRootNodeId,
                values: [],
            });
            return { status: 'pass' };
        }

        markSuppressedNativeSelectClick(context, event);
        deletePendingCustomSelectBySelector(context.state, context.recordingToken, context.tabName, event.selector || '');
        recordLog('record_select_suppress_write', {
            tabName: context.tabName,
            selector: event.selector,
            ts: event.ts,
        });

        const result = buildSelectOptionStep(context, event, 'native_select', [event.value]);
        recordLog('record_select_option_normalizer', {
            eventType: event.type,
            selector: event.selector,
            result: 'handled',
            reason: 'native_select',
            componentKind: binding.componentKind,
            targetNodeId: binding.targetNodeId,
            controlRootNodeId: binding.controlRootNodeId,
            values: [event.value.slice(0, 32)],
        });
        return result;
    }

    if (binding.componentKind === 'radio_group') {
        if (event.type !== 'check' || event.inputType !== 'radio') {
            return { status: 'pass' };
        }

        if (event.checked !== true) {
            recordLog('record_select_option_normalizer', {
                eventType: event.type,
                selector: event.selector,
                result: 'pending',
                reason: 'radio_unchecked',
                componentKind: binding.componentKind,
                targetNodeId: binding.targetNodeId,
                controlRootNodeId: binding.controlRootNodeId,
                values: [],
            });
            return { status: 'pending' };
        }

        const option = readControlOptionByNodeId(binding.component, binding.targetNodeId);
        if (!option) {return { status: 'pass' };}

        const value = readOptionRecordedValue(option);
        if (!value) {return { status: 'pass' };}

        const selector = readControlAnchorSelector(binding, event);
        const result = buildSelectOptionStep(context, event, 'radio_group', [value], selector);
        recordLog('record_select_option_normalizer', {
            eventType: event.type,
            selector: event.selector,
            controlAnchorSelector: selector,
            result: 'handled',
            reason: 'radio_group',
            componentKind: binding.componentKind,
            targetNodeId: binding.targetNodeId,
            controlRootNodeId: binding.controlRootNodeId,
            values: [value.slice(0, 32)],
        });
        return result;
    }

    if (binding.componentKind === 'checkbox_group') {
        if (event.type !== 'check' || event.inputType !== 'checkbox') {
            return { status: 'pass' };
        }

        const values = readSelectedValuesFromControl(binding.component);
        const sessions = readChoiceSessions(context.state, context.recordingToken);
        const sessionKey = checkboxSessionKey(context.workspaceName, context.tabName, binding.controlRootNodeId);
        const session: PendingCheckboxGroupSession = {
            kind: 'checkbox_group',
            sessionKey,
            controlRootNodeId: binding.controlRootNodeId,
            controlRef: binding.controlRef,
            workspaceName: context.workspaceName,
            tabName: context.tabName,
            selector: readControlAnchorSelector(binding, event),
            resolve: context.buildResolveFromEvent(event),
            values,
            lastEvent: event,
            ts: event.ts,
        };

        sessions.set(sessionKey, session);
        recordLog('record_select_option_normalizer', {
            eventType: event.type,
            selector: event.selector,
            controlAnchorSelector: session.selector,
            result: 'pending',
            reason: 'checkbox_group_session',
            componentKind: binding.componentKind,
            targetNodeId: binding.targetNodeId,
            controlRootNodeId: binding.controlRootNodeId,
            values: values.map((item) => item.slice(0, 32)),
        });
        return { status: 'pending' };
    }

    if (binding.componentKind === 'custom_select') {
        if (event.type !== 'click') {
            return { status: 'pass' };
        }

        const sessions = readChoiceSessions(context.state, context.recordingToken);
        const sessionKey = customSessionKey(context.workspaceName, context.tabName, binding.controlRootNodeId);

        if (binding.targetNodeId === binding.component.rootNodeId
            || binding.targetNodeId === binding.component.controlNodeId
            || binding.targetNodeId === binding.component.triggerNodeId) {
            const pendingSession: PendingCustomSelectSession = {
                kind: 'custom_select',
                source: 'bound_trigger',
                sessionKey,
                controlRootNodeId: binding.controlRootNodeId,
                controlRef: binding.controlRef,
                workspaceName: context.workspaceName,
                tabName: context.tabName,
                selector: event.selector,
                resolve: context.buildResolveFromEvent(event),
                triggerEvent: event,
                ts: event.ts,
            };

            sessions.set(sessionKey, pendingSession);
            recordLog('record_select_option_normalizer', {
                eventType: event.type,
                selector: event.selector,
                result: 'pending',
                reason: 'custom_trigger_session',
                componentKind: binding.componentKind,
                targetNodeId: binding.targetNodeId,
                controlRootNodeId: binding.controlRootNodeId,
                values: [],
            });
            return { status: 'pending' };
        }

        const pendingSession = sessions.get(sessionKey);
        if (!pendingSession || pendingSession.kind !== 'custom_select') {
            recordLog('record_select_option_normalizer', {
                eventType: event.type,
                selector: event.selector,
                result: 'pass',
                reason: 'custom_option_without_pending_trigger',
                componentKind: binding.componentKind,
                targetNodeId: binding.targetNodeId,
                controlRootNodeId: binding.controlRootNodeId,
                values: [],
            });
            return { status: 'pass' };
        }

        if (!binding.component.optionNodeIds.includes(binding.targetNodeId)) {
            recordLog('record_select_option_normalizer', {
                eventType: event.type,
                selector: event.selector,
                result: 'pass',
                reason: 'custom_click_not_option_node',
                componentKind: binding.componentKind,
                targetNodeId: binding.targetNodeId,
                controlRootNodeId: binding.controlRootNodeId,
                values: [],
            });
            return { status: 'pass' };
        }

        const option = readControlOptionByNodeId(binding.component, binding.targetNodeId);
        deleteChoiceSession(context.state, context.recordingToken, sessionKey);

        if (!option) {return { status: 'pass' };}

        const value = readOptionRecordedValue(option);
        if (!value) {return { status: 'pass' };}

        const result = buildSelectOptionStep(context, event, 'custom_select', [value]);
        recordLog('record_select_option_normalizer', {
            eventType: event.type,
            selector: event.selector,
            result: 'handled',
            reason: 'custom_option',
            componentKind: binding.componentKind,
            targetNodeId: binding.targetNodeId,
            controlRootNodeId: binding.controlRootNodeId,
            values: [value.slice(0, 32)],
        });
        return result;
    }

    recordLog('record_select_option_normalizer', {
        eventType: event.type,
        selector: event.selector,
        result: 'pass',
        reason: 'kind_not_matched',
        componentKind: binding.componentKind,
        targetNodeId: binding.targetNodeId,
        controlRootNodeId: binding.controlRootNodeId,
        values: [],
    });
    return { status: 'pass' };
};
