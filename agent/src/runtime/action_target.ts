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
 * 兼容保留：仅基于 workspaceName 解析目标。
 */
export const resolveActionTarget = (
    action: Action,
    pageRegistry: PageRegistry,
): ResolvedActionTarget | null => {
    if (!action.workspaceName) {return null;}
    try {
        const resolvedScope = pageRegistry.resolveScope({ workspaceId: action.workspaceName });
        const resolvedToken = pageRegistry.resolveTabToken(resolvedScope);
        return { tabToken: resolvedToken, scope: resolvedScope };
    } catch {
        throw new ActionTargetError(ERROR_CODES.ERR_BAD_ARGS, 'workspace scope not found for workspaceName');
    }
};
