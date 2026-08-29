import {SecurityError} from './errors';
import {sha256Hex} from './digest';

export type ApprovalPolicy = 'allow' | 'deny' | 'require-human';

export type ApprovalRequestMeta = Readonly<{
    id: string;
    operation: string;
    actor: string;
    scope: string;
    requestedAt: number;
}>;

export type ApprovalRequest = ApprovalRequestMeta & Readonly<{parameters?: unknown}>;

export type ApprovalOutcome = 'granted' | 'denied' | 'human-required';

export type ApprovalDecision = Readonly<{
    outcome: ApprovalOutcome;
    reason: string;
    policy: ApprovalPolicy;
    request: ApprovalRequestMeta;
    parametersDigest: string;
    decidedAt: number;
}>;

export type ApprovalServiceOptions = Readonly<{
    default: ApprovalPolicy;
    operations?: Readonly<Record<string, ApprovalPolicy>>;
}>;

export type ApprovalService = Readonly<{
    policy: ApprovalPolicy;
    evaluate: (request: ApprovalRequest) => ApprovalDecision;
}>;

const VALID_POLICIES: ReadonlySet<string> = new Set<string>(['allow', 'deny', 'require-human']);

const assertValidPolicy = (policy: ApprovalPolicy, name: string): void => {
    if (!VALID_POLICIES.has(policy)) {
        throw new SecurityError('ERR_SECURITY_DENIED', `${name} must be one of allow, deny, require-human, got ${policy}`);
    }
};

const assertNeverPolicy = (policy: never): never => {
    throw new SecurityError('ERR_SECURITY_DENIED', `unsupported approval policy: ${String(policy)}`);
};

export const resolveApprovalOutcome = (policy: ApprovalPolicy): Readonly<{outcome: ApprovalOutcome; reason: string}> => {
    switch (policy) {
        case 'allow':
            return {outcome: 'granted', reason: 'approved by policy'};
        case 'deny':
            return {outcome: 'denied', reason: 'denied by policy'};
        case 'require-human':
            return {outcome: 'human-required', reason: 'human approval required'};
        default:
            return assertNeverPolicy(policy);
    }
};

const canonicalValue = (value: unknown): unknown => {
    if (value === null) {return 'null';}
    if (value === undefined) {return '"$undefined"';}
    if (typeof value === 'bigint') {return value.toString();}
    if (typeof value === 'number' && !Number.isFinite(value)) {return String(value);}
    if (typeof value === 'function' || typeof value === 'symbol') {return String(value);}
    if (Array.isArray(value)) {return value.map(canonicalValue);}
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            out[key] = canonicalValue(record[key]);
        }
        return out;
    }
    return value;
};

export const hashParameters = (parameters: unknown): string =>
    `sha256:${sha256Hex(JSON.stringify(canonicalValue(parameters)))}`;

const resolveOperationPolicy = (
    operations: Readonly<Record<string, ApprovalPolicy>> | undefined,
    operation: string,
): ApprovalPolicy | undefined => {
    if (operations === undefined) {return undefined;}
    if (!Object.prototype.hasOwnProperty.call(operations, operation)) {return undefined;}
    const policy = operations[operation];
    assertValidPolicy(policy, `operations[${operation}]`);
    return policy;
};

export const createApprovalService = (options: ApprovalServiceOptions): ApprovalService => {
    assertValidPolicy(options.default, 'default');
    if (options.operations !== undefined) {
        for (const [operation, policy] of Object.entries(options.operations)) {
            assertValidPolicy(policy, `operations[${operation}]`);
        }
    }
    const operations = options.operations === undefined ? undefined : Object.freeze({...options.operations});
    return Object.freeze({
        policy: options.default,
        evaluate: (request) => {
            const policy = resolveOperationPolicy(operations, request.operation) ?? options.default;
            const {outcome, reason} = resolveApprovalOutcome(policy);
            const meta: ApprovalRequestMeta = {
                id: request.id,
                operation: request.operation,
                actor: request.actor,
                scope: request.scope,
                requestedAt: request.requestedAt,
            };
            return Object.freeze({
                outcome,
                reason,
                policy,
                request: Object.freeze(meta),
                parametersDigest: hashParameters(request.parameters),
                decidedAt: request.requestedAt,
            });
        },
    });
};

export const approvalAuditLine = (decision: ApprovalDecision): string => {
    const {outcome, policy, request, parametersDigest, decidedAt} = decision;
    return [
        `decidedAt=${decidedAt}`,
        `outcome=${outcome}`,
        `policy=${policy}`,
        `operation=${request.operation}`,
        `actor=${request.actor}`,
        `scope=${request.scope}`,
        `request=${request.id}`,
        `params=${parametersDigest}`,
    ].join(' ');
};