import type { Action } from '../shared/types.js';
import { ACTION_TYPES, deriveFailedActionType, isRequestActionType } from '../shared/action_types.js';
import type { RouterState, TabRuntimeState } from './state.js';

const PAGELESS_ACTIONS = new Set<string>([
    ACTION_TYPES.TAB_INIT,
    ACTION_TYPES.RECORD_LIST,
    ACTION_TYPES.RECORD_START,
    ACTION_TYPES.RECORD_STOP,
    ACTION_TYPES.RECORD_GET,
    ACTION_TYPES.RECORD_SAVE,
    ACTION_TYPES.RECORD_LOAD,
    ACTION_TYPES.RECORD_CLEAR,
    ACTION_TYPES.WORKFLOW_LIST,
    ACTION_TYPES.WORKFLOW_OPEN,
    ACTION_TYPES.WORKFLOW_STATUS,
    ACTION_TYPES.WORKFLOW_RECORD_SAVE,
    ACTION_TYPES.WORKFLOW_DSL_GET,
    ACTION_TYPES.WORKFLOW_DSL_TEST,
    ACTION_TYPES.WORKFLOW_RELEASE_RUN,
    ACTION_TYPES.WORKFLOW_INIT,
]);
const toStringOrUndefined = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

export const withActionBase = (action: Action): Action => ({
    v: 1 as const,
    id: action.id,
    type: action.type,
    workspaceName: action.workspaceName,
    payload: action.payload,
    at: action.at,
    traceId: action.traceId,
});

export const isFailedReply = (action: Action | null | undefined): boolean => {
    if (!action) {return false;}
    return action.type.endsWith('.failed');
};
export const payloadOf = (action: Action | null | undefined): Record<string, unknown> => {
    if (!action) {return {};}
    return (action.payload ?? {}) as Record<string, unknown>;
};

type ResolveDeps = {
    state: RouterState;
    ensureTabToken: (tabId: number, hintedWindowId?: number) => Promise<TabRuntimeState | null>;
    getActiveTabTokenForWindow: (windowId: number) => Promise<{ tabId: number; tabToken: string; urlHint: string; windowId: number } | null>;
};

type ResolvedIncomingAction = {
    scoped: Action;
    senderTabId?: number;
    senderWindowId?: number;
    resolvedWorkspaceName?: string;
};

const mkFailedAction = (type: string, replyTo: string | undefined, code: string, message: string): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    replyTo,
    payload: { code, message },
    at: Date.now(),
});

const mkInvalidEnvelopeAction = (replyTo?: string): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type: 'action.dispatch.failed',
    replyTo,
    payload: { code: 'ERR_BAD_ARGS', message: 'invalid action envelope' },
    at: Date.now(),
});

export const resolveIncomingAction = async (
    incoming: Action,
    sender: chrome.runtime.MessageSender,
    deps: ResolveDeps,
): Promise<{ ok: true; value: ResolvedIncomingAction } | { ok: false; reply: Action }> => {
    if (typeof incoming.id !== 'string' || typeof incoming.type !== 'string') {
        return { ok: false, reply: mkInvalidEnvelopeAction(incoming.id) };
    }
    if (!isRequestActionType(incoming.type)) {
        return {
            ok: false,
            reply: mkFailedAction(
                deriveFailedActionType(incoming.type),
                incoming.id,
                'ERR_BAD_ARGS',
                `unsupported command type '${incoming.type}'`,
            ),
        };
    }

    const isWorkspaceAction = incoming.type.startsWith('workspace.');
    const isPagelessAction = PAGELESS_ACTIONS.has(incoming.type) || isWorkspaceAction;
    const senderTabId = sender.tab?.id;
    const senderWindowId = sender.tab?.windowId;
    let resolvedWorkspaceName = incoming.workspaceName;

    if (!resolvedWorkspaceName && !isPagelessAction && typeof senderTabId === 'number') {
        const senderTabInfo = await deps.ensureTabToken(senderTabId, senderWindowId);
        if (senderTabInfo?.tabToken) {
            const tokenScope = deps.state.getTokenScope(senderTabInfo.tabToken);
            resolvedWorkspaceName = tokenScope?.workspaceId;
        }
    }

    if (!resolvedWorkspaceName && !isPagelessAction && typeof senderWindowId === 'number') {
        const active = await deps.getActiveTabTokenForWindow(senderWindowId);
        if (active?.tabToken) {
            const tokenScope = deps.state.getTokenScope(active.tabToken);
            resolvedWorkspaceName = tokenScope?.workspaceId;
        }
    }

    if (!resolvedWorkspaceName && !isPagelessAction) {
        return {
            ok: false,
            reply: mkFailedAction(deriveFailedActionType(incoming.type), incoming.id, 'ERR_BAD_ARGS', 'workspaceName unavailable'),
        };
    }

    const scoped: Action = {
        ...incoming,
        v: 1,
        id: incoming.id,
        at: incoming.at ?? Date.now(),
        workspaceName: resolvedWorkspaceName,
    };

    if (resolvedWorkspaceName) {deps.state.setActiveWorkspaceId(resolvedWorkspaceName);}

    return {
        ok: true,
        value: {
            scoped,
            senderTabId,
            senderWindowId,
            resolvedWorkspaceName,
        },
    };
};

export const applyReplyProjection = (
    resolved: ResolvedIncomingAction,
    reply: Action,
    sender: chrome.runtime.MessageSender,
    state: RouterState,
): void => {
    const responsePayload = payloadOf(reply);
    const replyWorkspaceName = toStringOrUndefined(responsePayload.workspaceName);
    const effectiveWorkspaceId = !isFailedReply(reply) ? (replyWorkspaceName ?? resolved.resolvedWorkspaceName ?? null) : null;
    if (isFailedReply(reply) || !effectiveWorkspaceId) {return;}

    const responseTabName = toStringOrUndefined(responsePayload.tabName);

    if (typeof resolved.senderTabId === 'number') {
        const senderState = state.getTabState(resolved.senderTabId);
        const senderTabToken = senderState?.tabToken;
        if (senderTabToken && responseTabName) {
            state.upsertTokenScope(senderTabToken, effectiveWorkspaceId, responseTabName);
            state.bindWorkspaceToWindowIfKnown(senderTabToken);
        }
        const senderUrl = sender.tab?.url ?? state.getTabState(resolved.senderTabId)?.lastUrl ?? '';
        if (typeof resolved.senderWindowId === 'number') {
            state.setWindowWorkspace(resolved.senderWindowId, effectiveWorkspaceId);
        }
    }
};

export const dispatchIncomingAction = async (
    incoming: Action,
    sender: chrome.runtime.MessageSender,
    deps: ResolveDeps & { sendAction: (action: Action) => Promise<Action> },
): Promise<Action> => {
    const resolved = await resolveIncomingAction(incoming, sender, deps);
    if (!resolved.ok) {return resolved.reply;}
    const reply = await deps.sendAction(resolved.value.scoped);
    applyReplyProjection(resolved.value, reply, sender, deps.state);
    return reply;
};
