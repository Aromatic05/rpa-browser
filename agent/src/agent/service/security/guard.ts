import type {AgentAuthzResult, AgentServiceEndpoint, AgentServiceSecurity} from './contracts';

const UNAUTHENTICATED: Extract<AgentAuthzResult, {ok: false}> = Object.freeze({
    ok: false as const,
    status: 401 as const,
    body: Object.freeze({error: 'authentication required', code: 'ERR_AGENT_AUTH_REQUIRED'}),
});

const FORBIDDEN: Extract<AgentAuthzResult, {ok: false}> = Object.freeze({
    ok: false as const,
    status: 403 as const,
    body: Object.freeze({error: 'forbidden', code: 'ERR_AGENT_FORBIDDEN'}),
});

export const authorizeAgentRequest = async (
    security: AgentServiceSecurity | undefined,
    authorization: string | undefined,
    endpoint: AgentServiceEndpoint,
): Promise<AgentAuthzResult> => {
    if (!security) {
        return {ok: true, principal: {id: 'anonymous', kind: 'anonymous'}};
    }

    const authResult = await security.authenticator.authenticate(authorization);
    if (!authResult.ok) {
        return UNAUTHENTICATED;
    }

    const requiredCapability = security.capabilities[endpoint];
    if (!authResult.capabilities.has(requiredCapability)) {
        return FORBIDDEN;
    }

    return {ok: true, principal: authResult.principal};
};
