/**
 * Agent 配置校验：范围、枚举、路径与密钥引用的安全形状检查。
 *
 * 规则与 agent 运行时既有约束保持一致：
 * - governance 数值约束与 createGovernancePolicy 相同
 * - 保留策略数值约束与 /sessions/prune 校验一致
 */

import path from 'node:path';
import type {
    AgentConfig,
    InteractionPolicy,
    IrreversibleApprovalMode,
} from './config_schema';
import { parseSecretRef } from './secret_ref';

const APPROVAL_MODES: readonly IrreversibleApprovalMode[] = ['deny', 'require-human', 'allow'];

const INTERACTION_POLICIES: readonly InteractionPolicy[] = ['interactive', 'headless'];

const fail = (field: string, message: string): never => {
    throw new Error(`agent.${field}: ${message}`);
};

function assertString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string') {
        fail(field, `must be a string, got ${typeof value}`);
    }
}

const assertPositiveInteger = (value: number, field: string, min: number): void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
        fail(field, `must be an integer >= ${min}, got ${String(value)}`);
    }
};

const assertNonNegativeNumber = (value: number, field: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(field, `must be a non-negative finite number, got ${String(value)}`);
    }
};

const assertNonEmptyPath = (value: unknown, field: string): void => {
    assertString(value, field);
    if (value.length === 0) {fail(field, 'must not be empty');}
    if (value.includes('\u0000')) {fail(field, 'must not contain NUL bytes');}
};

const assertUrlPath = (value: unknown, field: string): void => {
    assertString(value, field);
    if (!value.startsWith('/')) {fail(field, `must start with '/', got ${JSON.stringify(value)}`);}
    if (value.split('/').includes('..')) {fail(field, 'must not contain ".." path segments');}
    if (value.length > 1 && value.endsWith('/')) {fail(field, 'must not end with "/"');}
};

const assertModelDefaults = (agent: AgentConfig): void => {
    for (const key of ['provider', 'model', 'baseUrl'] as const) {
        assertString(agent.model[key], `model.${key}`);
    }
    const {provider, model, baseUrl} = agent.model;
    const configuredCount = [provider, model, baseUrl].filter((value) => value.length > 0).length;
    if (configuredCount > 0 && configuredCount < 3) {
        fail(
            'model',
            'provider, model and baseUrl must be configured together (all or none), ' +
                `got provider=${JSON.stringify(provider)}, model=${JSON.stringify(model)}, baseUrl=${JSON.stringify(baseUrl)}`,
        );
    }
    parseSecretRef(agent.model.apiKeyRef, 'agent.model.apiKeyRef');
};

const assertServiceBinding = (agent: AgentConfig): void => {
    assertNonEmptyPath(agent.service.host, 'service.host');
    assertPositiveInteger(agent.service.port, 'service.port', 0);
    if (agent.service.port > 65535) {
        fail('service.port', `must be <= 65535, got ${agent.service.port}`);
    }
    assertUrlPath(agent.service.agentPath, 'service.agentPath');
    assertUrlPath(agent.service.healthPath, 'service.healthPath');
};

const assertGovernanceBudget = (agent: AgentConfig): void => {
    const g = agent.governance;
    assertPositiveInteger(g.maxTurns, 'governance.maxTurns', 1);
    assertPositiveInteger(g.maxToolCalls, 'governance.maxToolCalls', 1);
    assertPositiveInteger(g.maxWorldEffects, 'governance.maxWorldEffects', 1);
    assertPositiveInteger(g.maxPostErrorEffects, 'governance.maxPostErrorEffects', 0);
    assertPositiveInteger(g.maxRecoveryAttempts, 'governance.maxRecoveryAttempts', 0);
    assertPositiveInteger(g.wallClockDeadlineMs, 'governance.wallClockDeadlineMs', 1);
    if (!APPROVAL_MODES.includes(g.irreversibleApproval)) {
        fail(
            'governance.irreversibleApproval',
            `must be one of ${APPROVAL_MODES.join(', ')}, got ${JSON.stringify(g.irreversibleApproval)}`,
        );
    }
};

const assertRetentionPolicy = (retention: AgentConfig['sessions']['retention'], field: string): void => {
    assertNonNegativeNumber(retention.maxAgeMs, `${field}.maxAgeMs`);
    assertPositiveInteger(retention.maxCount, `${field}.maxCount`, 0);
};

const assertSessions = (agent: AgentConfig): void => {
    assertNonEmptyPath(agent.sessions.storageRoot, 'sessions.storageRoot');
    assertRetentionPolicy(agent.sessions.retention, 'sessions.retention');
};

const assertReports = (agent: AgentConfig): void => {
    assertNonEmptyPath(agent.reports.root, 'reports.root');
    assertRetentionPolicy(agent.reports.retention, 'reports.retention');
    const expectedRoot = path.normalize(path.join(agent.sessions.storageRoot, 'reports'));
    const actualRoot = path.normalize(agent.reports.root);
    if (actualRoot !== expectedRoot) {
        fail(
            'reports.root',
            `must equal the co-located session reports directory (${JSON.stringify(expectedRoot)}), got ${JSON.stringify(agent.reports.root)}`,
        );
    }
    if (
        agent.reports.retention.maxAgeMs !== agent.sessions.retention.maxAgeMs
        || agent.reports.retention.maxCount !== agent.sessions.retention.maxCount
    ) {
        fail(
            'reports.retention',
            'must equal sessions.retention because reports are co-stored with sessions, ' +
                `sessions.retention=${JSON.stringify(agent.sessions.retention)}, got ${JSON.stringify(agent.reports.retention)}`,
        );
    }
};

const assertAuth = (agent: AgentConfig): void => {
    if (typeof agent.auth.enabled !== 'boolean') {
        fail('auth.enabled', `must be a boolean, got ${typeof agent.auth.enabled}`);
    }
    parseSecretRef(agent.auth.tokenRef, 'agent.auth.tokenRef');
};

const assertInteraction = (agent: AgentConfig): void => {
    if (!INTERACTION_POLICIES.includes(agent.interaction)) {
        fail(
            'interaction',
            `must be one of ${INTERACTION_POLICIES.join(', ')}, got ${JSON.stringify(agent.interaction)}`,
        );
    }
};

const isAgentObject = (value: unknown): value is AgentConfig =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

export const assertValidAgentConfig = (agent: unknown): void => {
    if (!isAgentObject(agent)) {
        throw new Error(
            `agent config must be an object, got ${agent === null ? 'null' : JSON.stringify(agent)}`,
        );
    }
    assertModelDefaults(agent);
    assertServiceBinding(agent);
    assertGovernanceBudget(agent);
    assertSessions(agent);
    assertReports(agent);
    assertAuth(agent);
    assertInteraction(agent);
};