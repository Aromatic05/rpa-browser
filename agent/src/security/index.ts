export {SecurityError} from './errors';
export type {SecurityErrorCode} from './errors';
export {sha256Hex} from './digest';

export {
    CAPABILITIES,
    CAPABILITY_LIST,
    isCapability,
    parseCapabilities,
    capabilityForBrowserTool,
    capabilityForTool,
    capabilityForActionType,
} from './capabilities';
export type {Capability} from './capabilities';

export {
    createCredentialRef,
    serializeCredentialRef,
    parseCredentialRef,
    credentialRefForEnv,
    createMemoryCredentialResolver,
    createEnvCredentialResolver,
    createDenyAllCredentialResolver,
} from './credentials';
export type {SecretValue, CredentialKind, CredentialRef, CredentialResolver} from './credentials';

export {
    isPrincipal,
    createSecurityContext,
    can,
    canAny,
    canAll,
    requireCapability,
    authorizeBrowserTool,
} from './context';
export type {PrincipalKind, Principal, SecurityContext, SecurityContextOptions} from './context';

export {createRedactionPolicy} from './redaction';
export type {RedactionOptions, RedactionPolicy, RedactionResult} from './redaction';

export {
    resolveApprovalOutcome,
    hashParameters,
    createApprovalService,
    approvalAuditLine,
} from './approval';
export type {
    ApprovalPolicy,
    ApprovalRequest,
    ApprovalRequestMeta,
    ApprovalOutcome,
    ApprovalDecision,
    ApprovalService,
    ApprovalServiceOptions,
} from './approval';

export {
    parseBearerToken,
    createBearerAuthenticator,
    bearerTokenDigest,
} from './auth';
export type {
    BearerToken,
    BearerTokenParseFailureCode,
    BearerAuthFailureCode,
    BearerAuthResult,
    BearerTokenVerifier,
    BearerAuthenticator,
} from './auth';