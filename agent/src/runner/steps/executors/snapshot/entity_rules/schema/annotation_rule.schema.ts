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

const columnSchema = z
    .object({
        fieldKey: nonEmptyString,
        name: nonEmptyString.optional(),
    })
    .strict();

const primaryKeySchema = z
    .object({
        fieldKey: nonEmptyString,
        columns: nonEmptyStringArray.optional(),
    })
    .strict();

const annotationRuleSchema = z
    .object({
        ruleId: nonEmptyString,
        businessTag: nonEmptyString.optional(),
        businessName: nonEmptyString.optional(),
        primaryKey: primaryKeySchema.optional(),
        columns: z.array(columnSchema).nonempty().optional(),
        fieldKey: nonEmptyString.optional(),
        actionIntent: nonEmptyString.optional(),
    })
    .strict()
    .refine(
        (value) =>
            Boolean(
                value.businessTag ||
                    value.businessName ||
                    value.primaryKey ||
                    value.columns ||
                    value.fieldKey ||
                    value.actionIntent,
            ),
        'annotation must contain at least one semantic field',
    );

export const entityAnnotationSetSchema = z
    .object({
        version: z.number().int().positive(),
        page: pageSchema,
        annotations: z.array(annotationRuleSchema).nonempty(),
    })
    .strict();

export type EntityAnnotationSetSchemaType = z.infer<typeof entityAnnotationSetSchema>;
