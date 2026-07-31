/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Runtime validators intentionally defend against untyped input. */
import type {Checkpoint} from '../checkpoint/types';
import {assertStepEntityRulesControl} from '../../snapshot/rules/model';

const MATCH_RULE_KEYS = new Set([
    'errorCode',
    'stepName',
    'urlIncludes',
    'textVisible',
    'entityExists',
]);
const POLICY_KEYS = new Set(['maxAttempts', 'retryOriginal', 'stopOnFailure']);

export const validateCheckpointRuntimeControls = (checkpoint: Checkpoint): void => {
    const raw = checkpoint as unknown as Record<string, unknown>;
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
        throw new Error(`checkpoint ${checkpoint.id} enabled must be a boolean`);
    }
    if (raw.priority !== undefined && (
        typeof raw.priority !== 'number' || !Number.isFinite(raw.priority)
    )) {
        throw new Error(`checkpoint ${checkpoint.id} priority must be a finite number`);
    }
    validateTrigger(checkpoint);
    validatePolicy(checkpoint);
};

const validateTrigger = (checkpoint: Checkpoint): void => {
    if (checkpoint.trigger === undefined) {return;}
    const trigger = checkpoint.trigger as unknown as Record<string, unknown>;
    for (const key of Object.keys(trigger)) {
        if (key !== 'matchRules' && key !== 'entityRules') {
            throw new Error(`checkpoint ${checkpoint.id} unsupported trigger field: ${key}`);
        }
    }
    const rules = trigger.matchRules as unknown[];
    for (const [index, rule] of rules.entries()) {
        validateMatchRule(checkpoint.id, index, rule);
    }
    if (trigger.entityRules !== undefined) {
        trigger.entityRules = assertStepEntityRulesControl(
            trigger.entityRules,
            `checkpoint ${checkpoint.id}.trigger.entityRules`,
        );
    }
};

const validateMatchRule = (checkpointId: string, index: number, value: unknown): void => {
    if (!isRecord(value)) {
        throw new Error(`checkpoint ${checkpointId} match rule must contain exactly one supported condition`);
    }
    const keys = Object.keys(value);
    if (keys.length !== 1 || !MATCH_RULE_KEYS.has(keys[0])) {
        throw new Error(`checkpoint ${checkpointId} match rule must contain exactly one supported condition`);
    }
    const key = keys[0];
    if (key === 'entityExists') {
        validateEntityExistsRule(checkpointId, index, value[key]);
        return;
    }
    if (typeof value[key] !== 'string' || !value[key].trim()) {
        throw new Error(`checkpoint ${checkpointId} matchRules[${index}].${key} must be a non-empty string`);
    }
};

const validateEntityExistsRule = (checkpointId: string, index: number, value: unknown): void => {
    if (!isRecord(value)) {
        throw new Error(`checkpoint ${checkpointId} matchRules[${index}].entityExists must be an object`);
    }
    for (const key of Object.keys(value)) {
        if (key !== 'query' && key !== 'kind' && key !== 'businessTag') {
            throw new Error(`checkpoint ${checkpointId} entityExists has unsupported field: ${key}`);
        }
    }
    if (typeof value.query !== 'string') {
        throw new Error(`checkpoint ${checkpointId} entityExists.query must be a string`);
    }
    validateStringOrStringArray(checkpointId, 'entityExists.kind', value.kind);
    validateStringOrStringArray(checkpointId, 'entityExists.businessTag', value.businessTag);
};

const validateStringOrStringArray = (
    checkpointId: string,
    field: string,
    value: unknown,
): void => {
    if (value === undefined) {return;}
    if (typeof value === 'string' && value.trim()) {return;}
    if (Array.isArray(value) && value.length > 0
        && value.every((item) => typeof item === 'string' && item.trim())) {return;}
    throw new Error(`checkpoint ${checkpointId} ${field} must be a non-empty string or string array`);
};

const validatePolicy = (checkpoint: Checkpoint): void => {
    const rawPolicy = (checkpoint as unknown as Record<string, unknown>).policy;
    if (rawPolicy === undefined) {return;}
    if (!isRecord(rawPolicy)) {
        throw new Error(`checkpoint ${checkpoint.id} policy must be an object`);
    }
    if ('trigger' in rawPolicy) {
        throw new Error(`checkpoint ${checkpoint.id} must keep trigger at checkpoint root`);
    }
    for (const key of Object.keys(rawPolicy)) {
        if (!POLICY_KEYS.has(key)) {
            throw new Error(`checkpoint ${checkpoint.id} unsupported policy field: ${key}`);
        }
    }
    if (rawPolicy.maxAttempts !== undefined && (
        typeof rawPolicy.maxAttempts !== 'number'
        || !Number.isSafeInteger(rawPolicy.maxAttempts)
        || rawPolicy.maxAttempts < 0
    )) {
        throw new Error(`checkpoint ${checkpoint.id} policy.maxAttempts must be a non-negative integer`);
    }
    if (rawPolicy.retryOriginal !== undefined && typeof rawPolicy.retryOriginal !== 'boolean') {
        throw new Error(`checkpoint ${checkpoint.id} policy.retryOriginal must be a boolean`);
    }
    normalizeLegacyPolicy(checkpoint);
};

const normalizeLegacyPolicy = (checkpoint: Checkpoint): void => {
    if (!checkpoint.policy) {return;}
    const policy = checkpoint.policy as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(policy, 'stopOnFailure')) {return;}
    if (policy.stopOnFailure !== true) {
        throw new Error(`checkpoint ${checkpoint.id} policy.stopOnFailure=false is unsupported`);
    }
    delete policy.stopOnFailure;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
