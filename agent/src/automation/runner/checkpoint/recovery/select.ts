import { buildPageSessionEntityView, filterPageSessionEntities } from '../../session/entity_view';
import { getLogger } from '../../../../platform/logging/logger';
import type { PageSnapshotSessionEntry } from '../../../snapshot';
import type { StepEntityRulesControl } from '../../../snapshot/rules/model';
import { isAutomaticRecoveryCheckpoint, getCheckpointMatchRules, type Checkpoint, type MatchRule } from '../types';
import type { EntityKind } from '../../steps/types';
import type {
    RecoveryFailureContext,
    RecoverySelection,
    RecoverySelectionInput,
    RecoveryWorldProbe,
} from './types';

const log = getLogger('step');

const FATAL_ERROR_CODES = new Set(['ERR_BAD_ARGS', 'ERR_INTERNAL']);

const firstRuleStepName = (checkpoint: Checkpoint) => {
    const matched = getCheckpointMatchRules(checkpoint).find((rule) => 'stepName' in rule);
    return matched && 'stepName' in matched ? matched.stepName : undefined;
};

const firstRuleErrorCode = (checkpoint: Checkpoint) => {
    const matched = getCheckpointMatchRules(checkpoint).find((rule) => 'errorCode' in rule);
    return matched && 'errorCode' in matched ? matched.errorCode : undefined;
};

export const enterRecovery = (input: {
    checkpointEnabled: boolean;
    inCheckpointFlow: boolean;
    errorCode?: string;
}): { entered: boolean } => {
    if (!input.checkpointEnabled || input.inCheckpointFlow) {
        return { entered: false };
    }
    if (input.errorCode && FATAL_ERROR_CODES.has(input.errorCode)) {
        return { entered: false };
    }
    return { entered: true };
};

export const getEffectiveRecoveryMaxAttempts = (checkpoint: Checkpoint, fallbackMaxAttempts: number): number => {
    const candidateMaxAttempts = checkpoint.policy?.maxAttempts;
    const policyMaxAttempts = typeof candidateMaxAttempts === 'number'
        && Number.isSafeInteger(candidateMaxAttempts)
        && candidateMaxAttempts >= 0
        ? candidateMaxAttempts
        : 1;
    return Math.min(policyMaxAttempts, fallbackMaxAttempts);
};

const attemptFor = (
    checkpointId: string,
    input: RecoverySelectionInput,
): number => input.checkpointAttempts?.[checkpointId] ?? input.checkpointAttempt;

export const evalRecoveryMatchRule = async (
    rule: MatchRule,
    failure: RecoveryFailureContext,
    world: RecoveryWorldProbe,
    entityRules?: StepEntityRulesControl,
): Promise<boolean> => {
    if ('errorCode' in rule) {
        return failure.error?.code === rule.errorCode;
    }
    if ('stepName' in rule) {
        return failure.stepName === rule.stepName;
    }
    if ('urlIncludes' in rule) {
        const url = await world.currentUrl();
        return Boolean(url?.includes(rule.urlIncludes));
    }
    if ('textVisible' in rule) {
        return await world.textVisible(rule.textVisible);
    }
    if ('entityExists' in rule) {
        return await world.entityExists(rule.entityExists, entityRules);
    }
    return false;
};

export const selectRecovery = async (input: RecoverySelectionInput): Promise<RecoverySelection> => {
    const candidates = [...input.checkpoints]
        .filter(isAutomaticRecoveryCheckpoint)
        .filter((item) => item.enabled !== false)
        .filter((item) => attemptFor(item.id, input) < getEffectiveRecoveryMaxAttempts(item, input.checkpointMaxAttempts))
        .filter((item) => {
            const scopedStepName = firstRuleStepName(item);
            return !scopedStepName || scopedStepName === input.failure.stepName;
        })
        .filter((item) => {
            const scopedErrorCode = firstRuleErrorCode(item);
            return !scopedErrorCode || scopedErrorCode === input.failure.error?.code;
        })
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    log.info('recovery.candidates', {
        stepName: input.failure.stepName,
        count: candidates.length,
        checkpointIds: candidates.map((candidate) => candidate.id),
    });

    for (const candidate of candidates) {
        let hit = true;
        const rules = getCheckpointMatchRules(candidate);
        for (const rule of rules) {
            if (!(await evalRecoveryMatchRule(rule, input.failure, input.world, candidate.trigger?.entityRules))) {
                hit = false;
                break;
            }
        }
        if (hit) {
            log.info('recovery.pick', {
                checkpointId: candidate.id,
                checkpointName: candidate.name,
                stepName: input.failure.stepName,
            });
            return { status: 'matched', checkpoint: candidate, attempt: attemptFor(candidate.id, input) };
        }
    }

    log.info('recovery.pick', { checkpointId: null, stepName: input.failure.stepName });
    return { status: 'no_match' };
};

export const entityExistsInPageSessionEntities = async (
    entry: PageSnapshotSessionEntry,
    args: { query: string; kind?: EntityKind | EntityKind[]; businessTag?: string | string[] },
): Promise<boolean> => {
    const entities = buildPageSessionEntityView(entry).entities;
    const matched = filterPageSessionEntities(entities, {
        kind: args.kind,
        businessTag: args.businessTag,
        query: args.query,
    });
    return matched.length > 0;
};

const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};

const visibleTextOfPageSession = (entry: PageSnapshotSessionEntry): string => {
    const observation = entry.capture.control.observation;
    const chunks: string[] = [];
    for (const nodeId of Object.keys(observation.nodes)) {
        if (!Object.hasOwn(observation.activity, nodeId)) {continue;}
        const facts = observation.activity[nodeId];
        if (!facts.rendered || facts.hiddenByStyle || !facts.subtreeActive || facts.inert) {continue;}
        const text = normalizeText(observation.text[nodeId]);
        if (text && !chunks.includes(text)) {chunks.push(text);}
    }
    return chunks.join(' ');
};

export const textVisibleInPageSession = async (
    entry: PageSnapshotSessionEntry,
    needle: string,
): Promise<boolean> => {
    const text = normalizeText(needle);
    if (!text) {return false;}
    return visibleTextOfPageSession(entry).includes(text);
};