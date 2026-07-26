import type { PersistentTargetDraft, CanvasDraft, CanvasValidationResult } from './types';

export const hasTargetConditions = (target: PersistentTargetDraft | undefined): boolean => {
    if (!target) {return false;}
    return Boolean(
        target.kind ||
            target.nameContains ||
            target.classContains ||
            target.textContains ||
            target.ariaContains ||
            target.keyHint ||
            target.relation,
    );
};

export const validateCanvasDraft = (draft: CanvasDraft): CanvasValidationResult => {
    const errors: string[] = [];

    if (!draft.page.kind) {
        errors.push('page.kind is required');
    }

    if (draft.entities.length === 0) {
        errors.push('at least one entity is required');
    }

    const businessTagSet = new Set<string>();
    for (const entity of draft.entities) {
        if (!entity.businessTag || !entity.businessTag.trim()) {
            errors.push(`entity ${entity.id}: businessTag is required`);
        } else if (businessTagSet.has(entity.businessTag)) {
            errors.push(`duplicate businessTag across entities: ${entity.businessTag}`);
        } else {
            businessTagSet.add(entity.businessTag);
        }

        if (!entity.name || !entity.name.trim()) {
            errors.push(`entity ${entity.id}: name (businessName) is required`);
        }

        if (!hasTargetConditions(entity.target)) {
            errors.push(`entity ${entity.id}: target must contain at least one match condition`);
        }

        const columnFieldKeys = new Set<string>();
        for (const column of entity.columns) {
            if (!column.fieldKey || !column.fieldKey.trim()) {
                errors.push(`entity ${entity.id}: column fieldKey is required`);
            } else if (columnFieldKeys.has(column.fieldKey)) {
                errors.push(`entity ${entity.id}: duplicate column fieldKey ${column.fieldKey}`);
            } else {
                columnFieldKeys.add(column.fieldKey);
            }

            const columnActionIntents = new Set<string>();
            for (const action of column.actions) {
                if (!action.actionIntent || !action.actionIntent.trim()) {
                    errors.push(`entity ${entity.id} column ${column.fieldKey}: action actionIntent is required`);
                } else if (columnActionIntents.has(action.actionIntent)) {
                    errors.push(`entity ${entity.id} column ${column.fieldKey}: duplicate actionIntent ${action.actionIntent}`);
                } else {
                    columnActionIntents.add(action.actionIntent);
                }
            }
        }

        const fieldKeys = new Set<string>();
        const actionIntents = new Set<string>();
        for (const annotation of entity.annotations) {
            if (!annotation.businessKey || !annotation.businessKey.trim()) {
                errors.push(`entity ${entity.id}: annotation businessKey is required`);
                continue;
            }
            if (annotation.type === 'field') {
                if (fieldKeys.has(annotation.businessKey)) {
                    errors.push(`entity ${entity.id}: duplicate annotation fieldKey ${annotation.businessKey}`);
                } else {
                    fieldKeys.add(annotation.businessKey);
                }
            } else if (annotation.type === 'action') {
                if (actionIntents.has(annotation.businessKey)) {
                    errors.push(`entity ${entity.id}: duplicate annotation actionIntent ${annotation.businessKey}`);
                } else {
                    actionIntents.add(annotation.businessKey);
                }
            }
        }

        if (entity.primaryKey && entity.primaryKey.fieldKey) {
            if (entity.columns.length > 0 && !columnFieldKeys.has(entity.primaryKey.fieldKey)) {
                errors.push(`entity ${entity.id}: primaryKey.fieldKey ${entity.primaryKey.fieldKey} not present in columns`);
            }
        }

        if (entity.pagination) {
            if (!entity.pagination.actionIntent || !entity.pagination.actionIntent.trim()) {
                errors.push(`entity ${entity.id}: pagination.actionIntent is required`);
            }
            if (!hasTargetConditions(entity.pagination.pageTarget)) {
                errors.push(`entity ${entity.id}: pagination.pageTarget must contain at least one match condition`);
            }
            if (entity.kind !== 'table') {
                errors.push(`entity ${entity.id}: pagination only allowed for table entities`);
            }
        }
    }

    return errors.length === 0 ? { ok: true } : { ok: false, errors };
};
