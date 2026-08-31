/**
 * RunnerConfig 入口：提供缓存读取与解析。
 */

import type { RunnerConfig } from './config_schema';
import { loadRunnerConfig } from './loader';

let cachedConfig: RunnerConfig | null = null;

export const getRunnerConfig = (): RunnerConfig => {
    if (!cachedConfig) {
        cachedConfig = loadRunnerConfig();
    }
    return cachedConfig;
};

export const resolveRunnerConfig = (overrides?: Partial<RunnerConfig>): RunnerConfig => {
    const base = loadRunnerConfig();
    return { ...base, ...overrides };
};

export type {
    RunnerConfig,
    McpToolGroup,
    McpPolicy,
    EntityRuleConfig,
    AgentConfig,
    AgentModelDefaults,
    AgentServiceBinding,
    GovernanceBudget,
    RetentionPolicy,
    SessionRetentionConfig,
    ReportRetentionConfig,
    AgentAuthConfig,
    InteractionPolicy,
    IrreversibleApprovalMode,
} from './config_schema';
export { defaultEntityRuleConfig, defaultEntityRuleRootDir, selectEntityRuleProfiles } from './entity_rules';
export { defaultAgentConfig } from './defaults';
export { assertValidAgentConfig } from './validate';
export type { SecretRef } from './secret_ref';
export { parseSecretRef, secretRefToRefString } from './secret_ref';
