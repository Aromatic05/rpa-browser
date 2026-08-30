import type {EntityRuleMatchArtifact, EntityRuleAnnotationArtifact, EntityRulePageApplicability} from '../../../src/automation/workflow/entity_rules';
import type {EffectReversibility} from '../../../src/program/effects/contracts';
import type {ClosedBetaSession} from './session';

/**
 * Entity-rule artifacts the closed-beta suite saves through the real
 * `entity_rules.save` WS action (the Annotate save surface) against the shared
 * `checkpoint_recorder.html` fixture.
 */

export type CheckpointFormRuleSpec = {
    profileName: string;
    pageUrl?: string;
    fieldEffect?: EffectReversibility | {reversibility: EffectReversibility; compensatable?: boolean};
    actionEffect?: EffectReversibility | {reversibility: EffectReversibility; compensatable?: boolean};
};

const reversibility = (
    spec: EffectReversibility | {reversibility: EffectReversibility; compensatable?: boolean} | undefined,
): {reversibility: EffectReversibility; compensatable?: boolean} | undefined => {
    if (spec === undefined) {
        return undefined;
    }
    if (typeof spec === 'string') {
        return {reversibility: spec};
    }
    return spec;
};

export const buildCheckpointFormRule = (spec: CheckpointFormRuleSpec): {
    profileName: string;
    page: EntityRulePageApplicability;
    match: EntityRuleMatchArtifact;
    annotation: EntityRuleAnnotationArtifact;
} => {
    const pageUrl = spec.pageUrl ?? 'checkpoint_recorder\\.html';
    return {
        profileName: spec.profileName,
        page: {kind: 'form', urlPattern: pageUrl},
        match: {
            version: 2,
            rules: [
                {ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'form', idEquals: 'order-query'}},
                {ruleId: 'order-no', source: 'node', expect: 'unique', within: 'root', match: {idEquals: 'order-no'}},
                {ruleId: 'buyer', source: 'node', expect: 'unique', within: 'root', match: {idEquals: 'buyer'}},
                {ruleId: 'query', source: 'node', expect: 'unique', within: 'root', match: {idEquals: 'query-orders'}},
            ],
        },
        annotation: {
            version: 2,
            bindings: [
                {
                    ruleId: 'root',
                    entityKey: 'ordersQuery',
                    businessTag: 'orders.query',
                    entityKind: 'form',
                    displayName: '订单查询',
                },
                {
                    ruleId: 'order-no',
                    fieldKey: 'orderNo',
                    fieldRole: 'field',
                    fieldName: '订单编号',
                    ...(reversibility(spec.fieldEffect) ? {effect: reversibility(spec.fieldEffect)} : {}),
                },
                {
                    ruleId: 'buyer',
                    fieldKey: 'buyer',
                    fieldRole: 'field',
                    fieldName: '采购人',
                    ...(reversibility(spec.fieldEffect) ? {effect: reversibility(spec.fieldEffect)} : {}),
                },
                {
                    ruleId: 'query',
                    actionIntent: 'query',
                    actionRole: 'form',
                    actionText: '查询',
                    ...(reversibility(spec.actionEffect) ? {effect: reversibility(spec.actionEffect)} : {}),
                },
            ],
        },
    };
};

export const saveEntityRule = async (
    session: ClosedBetaSession,
    rule: ReturnType<typeof buildCheckpointFormRule>,
): Promise<void> => {
    const reply = await session.dispatch('entity_rules.save', {
        profileName: rule.profileName,
        page: rule.page,
        match: rule.match,
        annotation: rule.annotation,
    });
    if (reply.type !== 'entity_rules.save.result') {
        throw new Error(`entity_rules.save failed (${reply.type}): ${JSON.stringify(reply.payload ?? {})}`);
    }
};