import { z } from 'zod';

const nonEmpty = (value: string) => value.trim().length > 0;
const nonEmptyString = z.string().refine(nonEmpty, 'must be non-empty string');
const nonEmptyStringArray = z.array(nonEmptyString).nonempty();

const pageSchema = z
    .object({
        kind: z.enum(['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv']),
        urlPattern: nonEmptyString.optional(),
    })
    .strict();

const keyHintMatchSchema = z
    .object({
        headerContainsAll: nonEmptyStringArray.optional(),
        primaryKeyCandidatesContains: nonEmptyStringArray.optional(),
    })
    .strict();

const ruleMatchSchema = z
    .object({
        kind: z.enum(['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv']).optional(),
        nameContains: nonEmptyString.optional(),
        keyHint: keyHintMatchSchema.optional(),
        relation: z.enum(['pagination']).optional(),
        classContains: nonEmptyString.optional(),
        textContains: nonEmptyString.optional(),
        ariaContains: nonEmptyString.optional(),
    })
    .strict()
    .refine(
        (value) =>
            Boolean(
                value.kind ||
                    value.nameContains ||
                    value.keyHint ||
                    value.relation ||
                    value.classContains ||
                    value.textContains ||
                    value.ariaContains,
            ),
        'match must contain at least one condition',
    );

const entityRuleSchema = z
    .object({
        ruleId: nonEmptyString,
        source: z.enum(['region', 'group', 'node']),
        expect: z.enum(['unique', 'one_or_more']),
        within: nonEmptyString.optional(),
        match: ruleMatchSchema,
    })
    .strict();

export const entityMatchRuleSetSchema = z
    .object({
        version: z.number().int().positive(),
        page: pageSchema,
        entities: z.array(entityRuleSchema).nonempty(),
    })
    .strict();

export type EntityMatchRuleSetSchemaType = z.infer<typeof entityMatchRuleSetSchema>;
