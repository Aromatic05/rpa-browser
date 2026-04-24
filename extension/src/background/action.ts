import type { Action } from '../shared/types.js';
import { ACTION_TYPES, deriveFailedActionType, isRequestActionType } from '../shared/action_types.js';
import type { RouterState, TabRuntimeState } from './state.js';

const PAGELESS_ACTIONS = new Set<string>([ACTION_TYPES.TAB_INIT, ACTION_TYPES.RECORD_LIST]);

export const withActionBase = (action: Action): Action => ({
    v: 1 as const,
    id: action.id || crypto.randomUUID(),
    type: action.type,
    payload: action.payload,
    scope: action.scope,
    tabToken: action.tabToken,
    at: action.at || Date.now(),
    traceId: action.traceId,
});

export const isFailedReply = (action: Action | null | undefined) => !!action?.type?.endsWith('.failed');
export const payloadOf = <T = Record<string, unknown>>(action: Action | null | undefined) => ((action?.payload || {}) as T);

type ResolveDeps = {
    state: RouterState;
    ensureTabToken: (tabId: number, hintedWindowId?: number) => Promise<TabRuntimeState | null>;
    getActiveTabTokenForWindow: (windowId: number) => Promise<{ tabId: number; tabToken: string; urlHint: string; windowId: number } | null>;
};

type ResolvedIncomingAction = {
    scoped: Action;
    senderTabId?: number;
    senderWindowId?: number;
    resolvedTabToken?: string;
    inferredScope?: { workspaceId: string; tabId: string };
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
    if (incoming.v !== 1 || typeof incoming.id !== 'string' || typeof incoming.type !== 'string') {
        return { ok: false, reply: mkInvalidEnvelopeAction(typeof incoming?.id === 'string' ? incoming.id : undefined) };
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
    let tabToken = (incoming.tabToken || incoming.scope?.tabToken);
    const senderTabId = sender.tab?.id;
    const senderWindowId = sender.tab?.windowId;

    if (!isPagelessAction && typeof senderTabId === 'number') {
        const senderTabInfo = await deps.ensureTabToken(senderTabId, senderWindowId);
        if (senderTabInfo?.tabToken) {tabToken = senderTabInfo.tabToken;}
    }

    if (!isPagelessAction && !tabToken && typeof senderWindowId === 'number') {
        const active = await deps.getActiveTabTokenForWindow(senderWindowId);
        if (active) {tabToken = active.tabToken;}
    }

    if (!tabToken && !isPagelessAction) {
        return {
            ok: false,
            reply: mkFailedAction(deriveFailedActionType(incoming.type), incoming.id, 'ERR_BAD_ARGS', 'tab token unavailable'),
        };
    }

    const tokenScope = tabToken ? deps.state.getTokenScope(tabToken) : undefined;
    const scope = tokenScope ? { workspaceId: tokenScope.workspaceId, tabId: tokenScope.tabId } : undefined;
    const requestedWorkspaceId = incoming.scope?.workspaceId;
    const requestedTabId = incoming.scope?.tabId;
    const hasExplicitScope = !!(requestedWorkspaceId || requestedTabId);

    const scopedScope = hasExplicitScope
        ? {
              ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
              ...(requestedTabId ? { tabId: requestedTabId } : {}),
          }
        : scope
          ? { workspaceId: scope.workspaceId, tabId: scope.tabId, ...(tabToken ? { tabToken } : {}) }
          : tabToken
            ? { tabToken }
            : {};

    const scoped: Action = {
        ...incoming,
        v: 1,
        id: incoming.id || crypto.randomUUID(),
        at: incoming.at || Date.now(),
        tabToken: hasExplicitScope ? undefined : tabToken,
        scope: scopedScope,
    };

    if (scope?.workspaceId) {deps.state.setActiveWorkspaceId(scope.workspaceId);}

    return {
        ok: true,
        value: {
            scoped,
            senderTabId,
            senderWindowId,
            resolvedTabToken: tabToken,
            inferredScope: scope,
        },
    };
};

export const applyReplyProjection = (
    resolved: ResolvedIncomingAction,
    reply: Action,
    sender: chrome.runtime.MessageSender,
    state: RouterState,
) => {
    const responsePayload = payloadOf(reply);
    const effectiveWorkspaceId = !isFailedReply(reply)
        ? (responsePayload as any)?.workspaceId || resolved.inferredScope?.workspaceId || state.getActiveWorkspaceId()
        : null;
    if (isFailedReply(reply) || !effectiveWorkspaceId) {return;}

    const responseTabToken = (responsePayload as any)?.tabToken as string | undefined;
    const responseTabId = (responsePayload as any)?.tabId as string | undefined;
    if (responseTabToken && responseTabId) {
        state.upsertTokenScope(responseTabToken, String(effectiveWorkspaceId), String(responseTabId));
        state.bindWorkspaceToWindowIfKnown(responseTabToken);
    }

    if (typeof resolved.senderTabId === 'number') {
        if (resolved.resolvedTabToken) {
            const oldTabId = state.findTabIdByToken(resolved.resolvedTabToken);
            if (oldTabId != null && oldTabId !== resolved.senderTabId) {
                state.removeTab(oldTabId);
            }
        }
        const senderUrl = sender.tab?.url || state.getTabState(resolved.senderTabId)?.lastUrl || '';
        if (resolved.resolvedTabToken) {
            state.upsertTab(resolved.senderTabId, resolved.resolvedTabToken, senderUrl, resolved.senderWindowId);
        }
        if (typeof resolved.senderWindowId === 'number') {
            state.setWindowWorkspace(resolved.senderWindowId, String(effectiveWorkspaceId));
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
