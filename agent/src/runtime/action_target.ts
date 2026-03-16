import type { Action } from '../actions/action_protocol';
import { ERROR_CODES } from '../actions/error_codes';
import type { PageRegistry } from './page_registry';

export class ActionTargetError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

type ResolvedActionTarget = {
    tabToken: string;
    scope: { workspaceId: string; tabId: string };
};

/**
 * 统一 Action 目标解析：
 * - tabToken 为强约束（单一真源）
 * - scope 作为定位 hint；若与 tabToken 冲突则拒绝执行
 */
export const resolveActionTarget = (
    action: Action,
    pageRegistry: PageRegistry,
): ResolvedActionTarget => {
    const scope = action.scope;
    const token = scope?.tabToken || action.tabToken;

    if (token) {
        const tokenScope = pageRegistry.resolveScopeFromToken(token);
        if (scope?.workspaceId && scope.workspaceId !== tokenScope.workspaceId) {
            throw new ActionTargetError(ERROR_CODES.ERR_BAD_ARGS, 'scope.workspaceId does not match tabToken');
        }
        if (scope?.tabId && scope.tabId !== tokenScope.tabId) {
            throw new ActionTargetError(ERROR_CODES.ERR_BAD_ARGS, 'scope.tabId does not match tabToken');
        }
        return { tabToken: token, scope: tokenScope };
    }

    if (scope?.workspaceId || scope?.tabId) {
        const resolvedScope = pageRegistry.resolveScope({
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
        });
        const resolvedToken = pageRegistry.resolveTabToken(resolvedScope);
        return { tabToken: resolvedToken, scope: resolvedScope };
    }

    const resolvedScope = pageRegistry.resolveScope();
    const resolvedToken = pageRegistry.resolveTabToken(resolvedScope);
    return { tabToken: resolvedToken, scope: resolvedScope };
};
