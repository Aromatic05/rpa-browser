import {
    getNodeContent,
    normalizeText,
} from '../../runner/steps/executors/snapshot/core/runtime_store';
import type {
    EntityKind,
    FinalEntityView,
    FinalEntityRecord,
    SnapshotResult,
    UnifiedNode,
} from '../../runner/steps/executors/snapshot/core/types';
import type {
    CanvasAnnotationDraft,
    CanvasDraft,
    CanvasEntityDraft,
    CanvasPageDraft,
} from './types';
import { entityCanvasId } from './identifiers';
import type { RecognizedItem } from './runtime_types';
import { buildNodeIndex, buildParentById, isDescendantOrSelf } from './picking';

export const inferPageKind = (finalEntityView: FinalEntityView | undefined): EntityKind => {
    if (!finalEntityView) {
        return 'form';
    }
    const counts = new Map<EntityKind, number>();
    for (const entity of finalEntityView.entities) {
        if (entity.type !== 'region') {
            continue;
        }
        counts.set(entity.kind, (counts.get(entity.kind) || 0) + 1);
    }
    if (counts.size === 0) {
        return 'form';
    }
    let best: EntityKind = 'form';
    let bestCount = 0;
    for (const [kind, count] of counts) {
        if (count > bestCount) {
            best = kind;
            bestCount = count;
        }
    }
    return best;
};

const buildEntityTarget = (entity: FinalEntityRecord): CanvasEntityDraft['target'] => {
    const target: CanvasEntityDraft['target'] = { kind: entity.kind };
    const name = normalizeText(entity.name);
    if (name) {
        target.nameContains = name;
    }
    return target;
};

const collectControlsInSubtree = (snapshot: SnapshotResult, rootNodeId: string): UnifiedNode[] => {
    const parentById = buildParentById(snapshot.root);
    const out: UnifiedNode[] = [];
    const interactiveRoles = new Set([
        'button',
        'link',
        'textbox',
        'combobox',
        'checkbox',
        'radio',
        'searchbox',
    ]);
    for (const node of Object.values(snapshot.nodeIndex)) {
        if (!isDescendantOrSelf(node.id, rootNodeId, parentById)) {
            continue;
        }
        const role = (normalizeText(node.role) || '').toLowerCase();
        if (node.control || interactiveRoles.has(role)) {
            out.push(node);
        }
    }
    return out;
};

const inferFormFieldsFromControls = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
): CanvasAnnotationDraft[] => {
    const controls = collectControlsInSubtree(snapshot, entity.nodeId);
    const annotations: CanvasAnnotationDraft[] = [];
    const nodes = buildNodeIndex(snapshot.root);
    const parentById = buildParentById(snapshot.root);
    let index = 0;
    for (const control of controls) {
        const role = (normalizeText(control.role) || '').toLowerCase();
        if (role === 'button' || role === 'link') {
            continue;
        }
        const parent = parentById.get(control.id);
        const parentName = parent ? normalizeText(nodes.get(parent)?.name) : undefined;
        const label = normalizeText(parentName || getNodeContent(control));
        const fieldKey = normalizeText(label) || `field_${index}`;
        annotations.push({
            id: `auto_${entity.id}_field_${index}`,
            type: 'field',
            businessKey: fieldKey,
            ...(label ? { name: label } : {}),
            target: {},
            expect: 'unique',
            origin: 'inferred',
            disposition: 'active',
        });
        index += 1;
    }
    return annotations;
};

const inferActionsFromControls = (entity: FinalEntityRecord): CanvasAnnotationDraft[] => {
    const annotations: CanvasAnnotationDraft[] = [];
    for (const action of entity.formActions || []) {
        annotations.push({
            id: `auto_${entity.id}_action_${action.actionIntent}`,
            type: 'action',
            businessKey: action.actionIntent,
            ...(action.text ? { name: action.text } : {}),
            target: {},
            expect: 'one_or_more',
            origin: 'inferred',
            disposition: 'active',
        });
    }
    return annotations;
};

const buildInferredEntity = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
    index: number,
): CanvasEntityDraft => {
    const id = entityCanvasId(index);
    const inferredFields = inferFormFieldsFromControls(snapshot, entity);
    const inferredActions = inferActionsFromControls(entity);
    const annotations =
        (entity.formFields || []).length > 0 || (entity.formActions || []).length > 0
            ? [
                  ...(entity.formFields || []).map((field, fieldIndex) => ({
                      id: `auto_${id}_field_${fieldIndex}`,
                      type: 'field' as const,
                      businessKey: field.fieldKey,
                      ...(field.name ? { name: field.name } : {}),
                      target: {},
                      expect: 'unique' as const,
                      origin: 'inferred' as const,
                      disposition: 'active' as const,
                  })),
                  ...inferredActions,
              ]
            : inferredFields;

    return {
        id,
        source: entity.type === 'group' ? 'group' : 'region',
        kind: entity.kind,
        name: normalizeText(entity.businessName || entity.name) || entity.id,
        businessTag: normalizeText(entity.businessTag) || `${entity.kind}.${entity.id}`,
        target: buildEntityTarget(entity),
        expect: 'unique',
        annotations,
        columns:
            entity.columns?.map((column, colIndex) => ({
                id: `${id}_col${colIndex}`,
                fieldKey: column.fieldKey,
                ...(column.name ? { name: column.name } : {}),
                ...(column.kind ? { kind: column.kind } : {}),
                actions:
                    column.actions?.map((action, actionIndex) => ({
                        id: `${id}_col${colIndex}_act${actionIndex}`,
                        actionIntent: action.actionIntent,
                        ...(action.text ? { text: action.text } : {}),
                        target: {},
                        origin: 'inferred',
                        disposition: 'active',
                    })) || [],
                origin: 'inferred',
                disposition: 'active',
            })) || [],
        ...(entity.primaryKey
            ? {
                  primaryKey: {
                      fieldKey: entity.primaryKey.fieldKey,
                      ...(entity.primaryKey.columns
                          ? { columns: [...entity.primaryKey.columns] }
                          : {}),
                  },
              }
            : {}),
        ...(entity.pagination?.nextAction
            ? {
                  pagination: {
                      actionIntent: entity.pagination.nextAction.actionIntent,
                      pageTarget: {},
                  },
              }
            : {}),
        origin: 'inferred',
    };
};

const isSignificantEntity = (entity: FinalEntityRecord): boolean => {
    if (entity.type === 'group') {
        return (entity.itemIds || []).length > 0;
    }
    return entity.kind === 'form' || entity.kind === 'table' || entity.kind === 'list';
};

const summarizeEntity = (
    entity: CanvasEntityDraft,
    origin: 'inferred' | 'existing',
): RecognizedItem => ({
    entityId: entity.id,
    kind: entity.kind,
    name: normalizeText(entity.name),
    fieldCount: entity.annotations.filter((annotation) => annotation.type === 'field').length,
    columnCount: entity.columns.length,
    actionCount:
        entity.annotations.filter((annotation) => annotation.type === 'action').length +
        entity.columns.reduce((sum, column) => sum + column.actions.length, 0),
    origin,
});

export const recognizeEntities = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
    existingDraft?: CanvasDraft,
): { canvasDraft: CanvasDraft; recognized: RecognizedItem[] } => {
    const pageKind = existingDraft?.page.kind || inferPageKind(finalEntityView);
    const page: CanvasPageDraft = existingDraft?.page || { kind: pageKind };

    const existingByNodeId = new Map<string, CanvasEntityDraft>();
    if (existingDraft) {
        for (const entity of existingDraft.entities) {
            existingByNodeId.set(entity.id, entity);
        }
    }

    const inferredNodeIds = new Set<string>();
    const entities: CanvasEntityDraft[] = existingDraft ? [...existingDraft.entities] : [];
    let inferredIndex = entities.length;
    const recognized: RecognizedItem[] = [];

    for (const existing of entities) {
        recognized.push(summarizeEntity(existing, 'existing'));
    }

    const significantEntities = (finalEntityView?.entities || []).filter(isSignificantEntity);
    let autoIndex = 0;
    for (const record of significantEntities) {
        if (inferredNodeIds.has(record.nodeId)) {
            continue;
        }
        inferredNodeIds.add(record.nodeId);
        const inferred = buildInferredEntity(snapshot, record, inferredIndex + autoIndex);
        autoIndex += 1;
        entities.push(inferred);
        recognized.push(summarizeEntity(inferred, 'inferred'));
    }

    const canvasDraft: CanvasDraft = existingDraft
        ? { ...existingDraft, entities }
        : {
              version: 1,
              profileName: '',
              page,
              entities,
              preserved: {
                  matchRaw: { version: 1, page, entities: [] },
                  annotationRaw: { version: 1, page, annotations: [] },
                  preservedByCanvasId: {},
                  ruleIdToCanvasId: {},
                  locatorRules: [],
                  ruleRefs: [],
              },
          };

    return { canvasDraft, recognized };
};
