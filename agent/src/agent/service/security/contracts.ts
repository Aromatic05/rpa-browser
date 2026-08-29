import type {BearerAuthenticator, Capability, RedactionPolicy} from '../../../security';
import type {Principal} from '../../../security/context';

export type AgentServiceEndpoint =
    | 'run'
    | 'sessionStart'
    | 'sessionList'
    | 'sessionStatus'
    | 'sessionReport'
    | 'sessionCancel'
    | 'sessionPrune';

export const AGENT_SERVICE_ENDPOINTS: readonly AgentServiceEndpoint[] = Object.freeze([
    'run',
    'sessionStart',
    'sessionList',
    'sessionStatus',
    'sessionReport',
    'sessionCancel',
    'sessionPrune',
]);

export type AgentServiceSecurity = Readonly<{
    authenticator: BearerAuthenticator;
    redactionPolicy: RedactionPolicy;
    capabilities: Readonly<Record<AgentServiceEndpoint, Capability>>;
}>;

export type AgentServiceSecurityOptions = Readonly<{
    authenticator?: BearerAuthenticator;
    redactionPolicy?: RedactionPolicy;
    capabilities?: Partial<Readonly<Record<AgentServiceEndpoint, Capability>>>;
}>;

export type AgentAuthzResult =
    | Readonly<{ok: true; principal: Principal}>
    | Readonly<{ok: false; status: 401 | 403; body: Readonly<{error: string; code: string}>}>;
