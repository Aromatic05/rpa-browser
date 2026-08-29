import type {CredentialResolver} from './credentials';
import {capabilityForBrowserTool, parseCapabilities, type Capability} from './capabilities';
import {SecurityError} from './errors';

export type PrincipalKind = 'human' | 'service' | 'system' | 'anonymous';

export type Principal = Readonly<{
    id: string;
    kind: PrincipalKind;
    displayName?: string;
    scopes?: readonly string[];
}>;

const PRINCIPAL_KINDS: ReadonlySet<string> = new Set<string>(['human', 'service', 'system', 'anonymous']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const isPrincipal = (value: unknown): value is Principal => {
    if (!isRecord(value)) {return false;}
    if (typeof value.id !== 'string' || value.id.length === 0) {return false;}
    if (typeof value.kind !== 'string' || !PRINCIPAL_KINDS.has(value.kind)) {return false;}
    if (value.displayName !== undefined && typeof value.displayName !== 'string') {return false;}
    if (value.scopes !== undefined) {
        if (!Array.isArray(value.scopes)) {return false;}
        if (!value.scopes.every((scope) => typeof scope === 'string')) {return false;}
    }
    return true;
};

export type SecurityContextOptions = Readonly<{
    principal: Principal;
    workspace: string;
    capabilities: Iterable<unknown>;
    resolver: CredentialResolver;
    createdAt?: number;
}>;

export type SecurityContext = Readonly<{
    principal: Principal;
    workspace: string;
    capabilities: ReadonlyArray<Capability>;
    resolver: CredentialResolver;
    createdAt: number;
}>;

export const createSecurityContext = (options: SecurityContextOptions): SecurityContext => {
    if (!isPrincipal(options.principal)) {
        throw new SecurityError('ERR_SECURITY_DENIED', 'invalid principal');
    }
    const workspace = options.workspace.trim();
    if (!workspace) {
        throw new SecurityError('ERR_SECURITY_DENIED', 'workspace must be a non-empty string');
    }
    const capabilities = parseCapabilities(options.capabilities);
    return Object.freeze({
        principal: Object.freeze({...options.principal}),
        workspace,
        capabilities,
        resolver: options.resolver,
        createdAt: options.createdAt ?? Date.now(),
    });
};

export const can = (context: SecurityContext, capability: Capability): boolean =>
    context.capabilities.includes(capability);

export const canAny = (context: SecurityContext, capabilities: readonly Capability[]): boolean =>
    capabilities.some((capability) => can(context, capability));

export const canAll = (context: SecurityContext, capabilities: readonly Capability[]): boolean =>
    capabilities.every((capability) => can(context, capability));

export const requireCapability = (context: SecurityContext, capability: Capability, operation: string): void => {
    if (!can(context, capability)) {
        throw new SecurityError('ERR_SECURITY_DENIED', `missing capability ${capability} required by ${operation}`);
    }
};

export const authorizeBrowserTool = (context: SecurityContext, toolName: string, operation: string): Capability => {
    const capability = capabilityForBrowserTool(toolName);
    if (capability === null) {
        throw new SecurityError('ERR_SECURITY_DENIED', `no capability is bound to tool ${toolName} for ${operation}`);
    }
    requireCapability(context, capability, `${operation}:${toolName}`);
    return capability;
};