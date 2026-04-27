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

const actionSchema = z
    .object({
        actionIntent: nonEmptyString,
        text: nonEmptyString.optional(),
    })
    .strict();

const columnSchema = z
    .object({
        fieldKey: nonEmptyString,
        name: nonEmptyString.optional(),
        kind: z.enum(['text', 'number', 'date', 'status', 'action_column']).optional(),
        actions: z.array(actionSchema).nonempty().optional(),
    })
    .strict();

const primaryKeySchema = z
    .object({
        fieldKey: nonEmptyString,
        columns: nonEmptyStringArray.optional(),
    })
    .strict();

const optionSourceSchema = z
    .object({
        kind: z.enum(['inline', 'popup']),
        optionRuleId: nonEmptyString.optional(),
    })
    .strict();

const fieldSchema = z
    .object({
        fieldKey: nonEmptyString,
        name: nonEmptyString.optional(),
        kind: z.enum(['input', 'textarea', 'select', 'radio', 'checkbox', 'date']).optional(),
        controlRuleId: nonEmptyString.optional(),
        labelRuleId: nonEmptyString.optional(),
        optionSource: optionSourceSchema.optional(),
    })
    .strict();

const formActionSchema = z
    .object({
        actionIntent: nonEmptyString,
        text: nonEmptyString.optional(),
        nodeRuleId: nonEmptyString.optional(),
    })
    .strict();

const paginationActionSchema = z
    .object({
        actionIntent: nonEmptyString,
        nodeRuleId: nonEmptyString,
        disabledRuleId: nonEmptyString.optional(),
    })
    .strict();

const paginationSchema = z
    .object({
        nextAction: paginationActionSchema,
    })
    .strict();

const annotationRuleSchema = z
    .object({
        ruleId: nonEmptyString,
        businessTag: nonEmptyString.optional(),
        businessName: nonEmptyString.optional(),
        primaryKey: primaryKeySchema.optional(),
        columns: z.array(columnSchema).nonempty().optional(),
        fields: z.array(fieldSchema).nonempty().optional(),
        actions: z.array(formActionSchema).nonempty().optional(),
        pagination: paginationSchema.optional(),
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
                    value.fields ||
                    value.actions ||
                    value.pagination ||
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
