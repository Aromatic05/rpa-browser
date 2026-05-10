import type { StepUnion } from '../../runner/steps/types';
import type { BaseControlComponent } from '../../runner/steps/executors/snapshot/control/types';
import { resolveRecordSnapshotForEvent } from '../enhancement/build';
import type { RecorderEvent } from '../capture/recorder';
import type {
    NormalizeContext,
    NormalizeHandledResult,
    RecordNormalizerResult,
} from './types';
import type {
    PendingCheckboxGroupSession,
    PendingChoiceSession,
    PendingCustomSelectSession,
    RecordingState,
} from '../pipeline/state';

type SelectOptionKind = 'native_select' | 'radio_group' | 'checkbox_group' | 'custom_select';

const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
    'native_select',
    'radio_group',
    'checkbox_group',
    'custom_select',
]);

const SELECT_OPTION_OWNER = 'browser.select_option';
type SnapshotResolver = typeof resolveRecordSnapshotForEvent;
let snapshotResolver: SnapshotResolver = resolveRecordSnapshotForEvent;

export const setSelectOptionSnapshotResolverForTest = (resolver: SnapshotResolver | null): void => {
    snapshotResolver = resolver || resolveRecordSnapshotForEvent;
};

type ControlMatch = {
    nodeId: string;
    component: BaseControlComponent;
    controlRef: string;
};

type OptionEntry = {
    value?: string;
    label?: string;
    text?: string;
    selected?: boolean;
    nodeId?: string;
};

const normalize = (value: string | undefined): string => (value || '').trim();

const toOptionEntries = (component: BaseControlComponent): OptionEntry[] => {
    const rawOptions = component.data?.options;
    if (!Array.isArray(rawOptions)) {return [];}
    const options: OptionEntry[] = [];
    for (const item of rawOptions) {
        if (!item || typeof item !== 'object') {continue;}
        const entry = item as Record<string, unknown>;
        options.push({
            value: typeof entry.value === 'string' ? entry.value : undefined,
            label: typeof entry.label === 'string' ? entry.label : undefined,
            text: typeof entry.text === 'string' ? entry.text : undefined,
            selected: typeof entry.selected === 'boolean' ? entry.selected : undefined,
            nodeId: typeof entry.nodeId === 'string' ? entry.nodeId : undefined,
        });
    }
    return options;
};

const readOptionValue = (option: OptionEntry): string | undefined => {
    const fromValue = normalize(option.value);
    if (fromValue) {return fromValue;}
    const fromLabel = normalize(option.label);
    if (fromLabel) {return fromLabel;}
    const fromText = normalize(option.text);
    if (fromText) {return fromText;}
    return undefined;
};

const readComponentKind = (component: BaseControlComponent): SelectOptionKind | undefined => {
    if (!SUPPORTED_KINDS.has(component.kind)) {return undefined;}
    return component.kind as SelectOptionKind;
};

const hasSelectOptionCapability = (component: BaseControlComponent): boolean => {
    return component.owner === SELECT_OPTION_OWNER
        && Array.isArray(component.capabilities)
        && component.capabilities.includes('select_option');
};

const findControlMatchForEvent = async (
    context: NormalizeContext,
    event: RecorderEvent,
): Promise<ControlMatch | undefined> => {
    const selector = normalize(event.selector);
    if (!selector) {return undefined;}
    const snapshot = await snapshotResolver({
        event,
        page: context.page,
        snapshotCache: context.snapshotCache,
        cacheKey: context.cacheKey,
    });
    if (!snapshot) {return undefined;}

    const matchedNodeIds = new Set<string>();
    for (const [nodeId, locator] of Object.entries(snapshot.locatorIndex || {})) {
        if (normalize(locator.direct?.query) === selector) {
            matchedNodeIds.add(nodeId);
            continue;
        }
        if (normalize(locator.direct?.fallback) === selector) {
            matchedNodeIds.add(nodeId);
        }
    }

    for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex || {})) {
        const idValue = normalize(attrs.id);
        if (idValue && selector === `#${idValue}`) {
            matchedNodeIds.add(nodeId);
        }
        const testId = normalize(attrs['data-testid']);
        if (testId && selector === `[data-testid="${testId}"]`) {
            matchedNodeIds.add(nodeId);
        }
    }

    if (matchedNodeIds.size !== 1) {return undefined;}
    const nodeId = Array.from(matchedNodeIds)[0];
    const node = snapshot.nodeIndex[nodeId];
    const controlRef = node?.control?.ref;
    if (!controlRef) {return undefined;}
    const component = snapshot.controlIndex?.[controlRef];
    if (!component) {return undefined;}
    if (!hasSelectOptionCapability(component)) {return undefined;}
    const kind = readComponentKind(component);
    if (!kind) {return undefined;}

    return { nodeId, component, controlRef };
};

const buildSelectOptionStep = (
    context: NormalizeContext,
    event: RecorderEvent,
    values: string[],
): NormalizeHandledResult => {
    const step = context.createStep(
        'browser.select_option',
        {
            selector: event.selector,
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

const snapshotSelectedValues = (component: BaseControlComponent): string[] => {
    const options = toOptionEntries(component);
    const selected: string[] = [];
    for (const option of options) {
        if (option.selected !== true) {continue;}
        const value = readOptionValue(option);
        if (!value) {continue;}
        selected.push(value);
    }
    return selected;
};

const matchOptionByNodeId = (component: BaseControlComponent, nodeId: string): OptionEntry | undefined => {
    for (const option of toOptionEntries(component)) {
        if (option.nodeId === nodeId) {
            return option;
        }
    }
    return undefined;
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
                    values: [...session.values],
                },
                session.lastEvent.ts,
                { tabName: session.tabName },
                session.resolve,
            );
            emitted.push({ step, event: session.lastEvent });
        } else if (session.kind === 'custom_select' && input.reason !== 'navigate' && input.reason !== 'click') {
            const step = input.context.createStep(
                'browser.click',
                { selector: session.selector },
                session.triggerEvent.ts,
                { tabName: session.tabName },
                session.resolve,
            );
            emitted.push({ step, event: session.triggerEvent });
        } else if (session.kind === 'custom_select' && input.reason === 'click') {
            continue;
        }
        deleteChoiceSession(input.state, input.recordingToken, session.sessionKey);
    }
    return emitted;
};

export const normalizeSelectOption = async (
    context: NormalizeContext,
    event: RecorderEvent,
): Promise<RecordNormalizerResult> => {
    const sessions = context.state.pendingChoiceEvents.get(context.recordingToken);
    const pendingCustom = sessions
        ? Array.from(sessions.values()).find((item) => item.kind === 'custom_select') as PendingCustomSelectSession | undefined
        : undefined;
    const match = await findControlMatchForEvent(context, event);
    if (event.type === 'click' && pendingCustom) {
        const sameControl = Boolean(match && readComponentKind(match.component) === 'custom_select' && match.component.rootNodeId === pendingCustom.controlRootNodeId);
        if (!sameControl) {
            const step = buildReleasedTriggerClickStep(context, pendingCustom.triggerEvent);
            deleteChoiceSession(context.state, context.recordingToken, pendingCustom.sessionKey);
            return {
                status: 'handled',
                step,
                enhancementEvent: pendingCustom.triggerEvent,
            };
        }
    }

    if (!match) {
        return { status: 'pass' };
    }
    const kind = readComponentKind(match.component);
    if (!kind) {
        return { status: 'pass' };
    }

    if (kind === 'native_select') {
        if (event.type !== 'select' || typeof event.value !== 'string') {
            return { status: 'pass' };
        }
        return buildSelectOptionStep(context, event, [event.value]);
    }

    if (kind === 'radio_group') {
        if (event.type !== 'check' || event.inputType !== 'radio') {
            return { status: 'pass' };
        }
        if (event.checked !== true) {return { status: 'pending' };}
        const option = matchOptionByNodeId(match.component, match.nodeId);
        if (!option) {return { status: 'pass' };}
        const value = readOptionValue(option);
        if (!value) {return { status: 'pass' };}
        return buildSelectOptionStep(context, event, [value]);
    }

    if (kind === 'checkbox_group') {
        if (event.type !== 'check' || event.inputType !== 'checkbox') {
            return { status: 'pass' };
        }
        const values = snapshotSelectedValues(match.component);
        const sessions = readChoiceSessions(context.state, context.recordingToken);
        const sessionKey = checkboxSessionKey(context.workspaceName, context.tabName, match.component.rootNodeId);
        const session: PendingCheckboxGroupSession = {
            kind: 'checkbox_group',
            sessionKey,
            controlRootNodeId: match.component.rootNodeId,
            controlRef: match.controlRef,
            workspaceName: context.workspaceName,
            tabName: context.tabName,
            selector: event.selector,
            resolve: context.buildResolveFromEvent(event),
            values,
            lastEvent: event,
            ts: event.ts,
        };
        sessions.set(sessionKey, session);
        return { status: 'pending' };
    }

    if (kind === 'custom_select') {
        const customSessions = readChoiceSessions(context.state, context.recordingToken);
        const sessionKey = customSessionKey(context.workspaceName, context.tabName, match.component.rootNodeId);

        if (event.type !== 'click') {
            return { status: 'pass' };
        }

        const triggerNodeIds = new Set<string>([
            match.component.rootNodeId,
            match.component.controlNodeId || '',
            match.component.triggerNodeId || '',
        ]);
        if (triggerNodeIds.has(match.nodeId)) {
            const pendingSession: PendingCustomSelectSession = {
                kind: 'custom_select',
                sessionKey,
                controlRootNodeId: match.component.rootNodeId,
                controlRef: match.controlRef,
                workspaceName: context.workspaceName,
                tabName: context.tabName,
                selector: event.selector,
                resolve: context.buildResolveFromEvent(event),
                triggerEvent: event,
                ts: event.ts,
            };
            customSessions.set(sessionKey, pendingSession);
            return { status: 'pending' };
        }

        const pendingSession = customSessions.get(sessionKey);
        if (!pendingSession || pendingSession.kind !== 'custom_select') {
            return { status: 'pass' };
        }

        const optionNodeIds = new Set<string>(match.component.optionNodeIds || []);
        if (!optionNodeIds.has(match.nodeId)) {
            return { status: 'pass' };
        }

        const option = matchOptionByNodeId(match.component, match.nodeId);
        deleteChoiceSession(context.state, context.recordingToken, sessionKey);
        if (!option) {return { status: 'pass' };}
        const value = readOptionValue(option);
        if (!value) {return { status: 'pass' };}
        return buildSelectOptionStep(context, event, [value]);
    }

    return { status: 'pass' };
};
