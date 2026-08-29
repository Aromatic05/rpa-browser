import {CAPABILITIES, createRedactionPolicy} from '../../../security';
import type {AgentServiceSecurity, AgentServiceSecurityOptions} from './contracts';

const DEFAULT_CAPABILITY = CAPABILITIES.AGENT_RUN;

const buildCapabilities = (
    overrides: AgentServiceSecurityOptions['capabilities'],
): AgentServiceSecurity['capabilities'] =>
    Object.freeze({
        run: overrides?.run ?? DEFAULT_CAPABILITY,
        sessionStart: overrides?.sessionStart ?? DEFAULT_CAPABILITY,
        sessionList: overrides?.sessionList ?? DEFAULT_CAPABILITY,
        sessionStatus: overrides?.sessionStatus ?? DEFAULT_CAPABILITY,
        sessionReport: overrides?.sessionReport ?? DEFAULT_CAPABILITY,
        sessionCancel: overrides?.sessionCancel ?? DEFAULT_CAPABILITY,
        sessionPrune: overrides?.sessionPrune ?? DEFAULT_CAPABILITY,
    });

export const createAgentServiceSecurity = (
    options: AgentServiceSecurityOptions = {},
): AgentServiceSecurity | null => {
    if (!options.authenticator) {
        return null;
    }

    return Object.freeze({
        authenticator: options.authenticator,
        redactionPolicy: options.redactionPolicy ?? createRedactionPolicy(),
        capabilities: buildCapabilities(options.capabilities),
    });
};
