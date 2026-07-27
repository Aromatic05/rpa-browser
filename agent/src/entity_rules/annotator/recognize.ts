import {
    getNodeAttr,
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
import { buildNodeIndex, buildParentById, countMatches, isDescendantOrSelf } from './picking';
import { protectiveMerge } from './merge';

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

const buildNodeTarget = (
    snapshot: SnapshotResult,
    nodeId: string | undefined,
    options: {allowText?: boolean} = {},
): CanvasEntityDraft['target'] => {
    if (!nodeId) {return {};}
    const node = snapshot.nodeIndex[nodeId];
    if (!node) {return {};}
    const id = normalizeText(getNodeAttr(node, 'id'));
    if (id) {return {idEquals: id};}
    const name = normalizeText(getNodeAttr(node, 'name'));
    if (name) {return {nameEquals: name};}
    const aria = normalizeText(getNodeAttr(node, 'aria-label') || getNodeAttr(node, 'title'));
    if (aria) {return {ariaContains: aria};}
    const className = normalizeText(getNodeAttr(node, 'class'));
    const classToken = className?.split(/\s+/).find((token) => token.length >= 2 && !/[0-9a-f]{8,}/i.test(token));
    if (classToken) {return {classContains: classToken};}
    const text = normalizeText(node.name || getNodeContent(node));
    if (options.allowText && text && text.length <= 24) {return {textContains: text};}
    const role = normalizeText(node.role);
    return role ? {roleEquals: role} : {};
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
    const interactiveTags = new Set(['input', 'select', 'textarea', 'button', 'a']);
    for (const node of Object.values(snapshot.nodeIndex)) {
        if (!isDescendantOrSelf(node.id, rootNodeId, parentById)) {
            continue;
        }
        const role = (normalizeText(node.role) || '').toLowerCase();
        const tag = (normalizeText(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName')) || '').toLowerCase();
        if (node.control || interactiveRoles.has(role) || interactiveTags.has(tag)) {
            out.push(node);
        }
    }
    return out;
};

const inferActionIntentFromText = (value: string | undefined): string | null => {
    const text = (normalizeText(value) || '').toLowerCase().replace(/\s+/g, '');
    if (!text) {return null;}
    if (text.includes('查询') || text.includes('搜索') || text.includes('search')) {return 'search';}
    if (text.includes('重置') || text.includes('清空') || text.includes('reset')) {return 'reset';}
    if (text.includes('提交') || text.includes('submit')) {return 'submit';}
    if (text.includes('保存') || text.includes('save')) {return 'save';}
    if (text.includes('新增') || text.includes('创建') || text.includes('add') || text.includes('create')) {return 'create';}
    if (text.includes('编辑') || text.includes('修改') || text.includes('edit')) {return 'edit';}
    if (text.includes('删除') || text.includes('移除') || text.includes('delete') || text.includes('remove')) {return 'delete';}
    if (text.includes('查看') || text.includes('详情') || text.includes('view') || text.includes('detail')) {return 'view';}
    return null;
};

const isNextPageControl = (
    snapshot: SnapshotResult,
    node: UnifiedNode,
    parentById: Map<string, string | null>,
    scopeNodeId: string,
): boolean => {
    const text = (normalizeText(node.name || getNodeContent(node)) || '').toLowerCase().replace(/\s+/g, '');
    const className = (normalizeText(getNodeAttr(node, 'class')) || '').toLowerCase();
    const id = (normalizeText(getNodeAttr(node, 'id')) || '').toLowerCase();
    if (
        text.includes('下一页') ||
        text === 'next' ||
        text.includes('nextpage') ||
        className.includes('pagination-next') ||
        id.includes('nextpage')
    ) {
        return true;
    }
    let cursor = parentById.get(node.id) || null;
    while (cursor && cursor !== scopeNodeId) {
        const ancestor = snapshot.nodeIndex[cursor];
        if (!ancestor) {break;}
        const role = (normalizeText(ancestor.role) || '').toLowerCase();
        const ancestorClass = (normalizeText(getNodeAttr(ancestor, 'class')) || '').toLowerCase();
        const ancestorName = (normalizeText(ancestor.name) || '').toLowerCase();
        if (
            (role === 'navigation' || ancestorClass.includes('pagination') || ancestorName.includes('分页')) &&
            (text.includes('下') || text.includes('next') || className.includes('next') || id.includes('next'))
        ) {
            return true;
        }
        cursor = parentById.get(cursor) || null;
    }
    return false;
};

const inferControlLabel = (
    snapshot: SnapshotResult,
    control: UnifiedNode,
    scopeNodeId: string,
    parentById: Map<string, string | null>,
): string | undefined => {
    const controlId = normalizeText(getNodeAttr(control, 'id'));
    if (controlId) {
        for (const node of Object.values(snapshot.nodeIndex)) {
            if (!isDescendantOrSelf(node.id, scopeNodeId, parentById)) {continue;}
            const tag = (normalizeText(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName')) || '').toLowerCase();
            if (tag !== 'label' && (normalizeText(node.role) || '').toLowerCase() !== 'label') {continue;}
            if (normalizeText(getNodeAttr(node, 'for')) !== controlId) {continue;}
            const label = normalizeText(node.name || getNodeContent(node));
            if (label) {return label;}
        }
    }

    const aria = normalizeText(
        getNodeAttr(control, 'aria-label') ||
        getNodeAttr(control, 'title') ||
        getNodeAttr(control, 'placeholder'),
    );
    if (aria) {return aria;}

    let cursor = parentById.get(control.id) || null;
    while (cursor && cursor !== scopeNodeId) {
        const ancestor = snapshot.nodeIndex[cursor];
        if (!ancestor) {break;}
        const tag = (normalizeText(getNodeAttr(ancestor, 'tag') || getNodeAttr(ancestor, 'tagName')) || '').toLowerCase();
        const role = (normalizeText(ancestor.role) || '').toLowerCase();
        if (tag === 'label' || role === 'label') {
            const label = normalizeText(ancestor.name || getNodeContent(ancestor));
            if (label) {return label;}
        }
        cursor = parentById.get(cursor) || null;
    }
    return undefined;
};

const inferUnclaimedScopeControls = (
    snapshot: SnapshotResult,
    scopeNodeId: string,
    claimedRootIds: string[],
): {
    annotations: CanvasAnnotationDraft[];
    pagination?: NonNullable<CanvasEntityDraft['pagination']>;
} => {
    const parentById = buildParentById(snapshot.root);
    const controls = collectControlsInSubtree(snapshot, scopeNodeId);
    const annotations: CanvasAnnotationDraft[] = [];
    let fieldIndex = 0;
    let actionIndex = 0;
    let pagination: NonNullable<CanvasEntityDraft['pagination']> | undefined;

    for (const control of controls) {
        const claimed = claimedRootIds.some((rootId) =>
            isDescendantOrSelf(control.id, rootId, parentById),
        );
        if (claimed) {continue;}

        if (!pagination && isNextPageControl(snapshot, control, parentById, scopeNodeId)) {
            pagination = {
                actionIntent: 'nextPage',
                pageTarget: buildNodeTarget(snapshot, control.id, {allowText: true}),
            };
            continue;
        }

        const role = (normalizeText(control.role) || '').toLowerCase();
        if (role !== 'button' && role !== 'link') {
            const key = normalizeText(
                getNodeAttr(control, 'name') ||
                getNodeAttr(control, 'id') ||
                control.name,
            ) || `field_${fieldIndex}`;
            const label = inferControlLabel(snapshot, control, scopeNodeId, parentById) ||
                normalizeText(control.name || getNodeContent(control)) ||
                key;
            annotations.push({
                id: `auto_scope_field_${fieldIndex}`,
                type: 'field',
                businessKey: key,
                name: label,
                target: buildNodeTarget(snapshot, control.id),
                expect: 'unique',
                origin: 'inferred',
                disposition: 'active',
            });
            fieldIndex += 1;
            continue;
        }

        const label = normalizeText(control.name || getNodeContent(control));
        const actionIntent = inferActionIntentFromText(label);
        if (!actionIntent) {continue;}
        annotations.push({
            id: `auto_scope_action_${actionIndex}`,
            type: 'action',
            businessKey: actionIntent,
            ...(label ? {name: label} : {}),
            target: buildNodeTarget(snapshot, control.id, {allowText: true}),
            expect: 'unique',
            origin: 'inferred',
            disposition: 'active',
        });
        actionIndex += 1;
    }

    return {annotations, ...(pagination ? {pagination} : {})};
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

const inferRowActionsFromControls = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
): CanvasEntityDraft['columns'][number]['actions'] => {
    if (entity.kind !== 'table' && entity.kind !== 'list') {return [];}
    const actions: CanvasEntityDraft['columns'][number]['actions'] = [];
    const seen = new Set<string>();
    for (const control of collectControlsInSubtree(snapshot, entity.nodeId)) {
        const role = (normalizeText(control.role) || '').toLowerCase();
        const tag = (normalizeText(getNodeAttr(control, 'tag') || getNodeAttr(control, 'tagName')) || '').toLowerCase();
        if (role !== 'button' && role !== 'link' && tag !== 'button' && tag !== 'a') {continue;}
        const text = normalizeText(control.name || getNodeContent(control));
        const actionIntent = inferActionIntentFromText(text);
        if (!actionIntent || !['edit', 'delete', 'view'].includes(actionIntent) || seen.has(actionIntent)) {continue;}
        seen.add(actionIntent);
        const target = buildNodeTarget(snapshot, control.id, {allowText: true});
        if (text && target.classContains) {
            target.textContains = text;
        }
        actions.push({
            id: `auto_${entity.id}_row_action_${actionIntent}`,
            actionIntent,
            ...(text ? {text} : {}),
            target,
            origin: 'inferred',
            disposition: 'active',
        });
    }
    return actions;
};

const buildInferredEntity = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
    index: number,
): CanvasEntityDraft => {
    const id = entityCanvasId(index);
    const inferredFields = inferFormFieldsFromControls(snapshot, entity);
    const annotations =
        (entity.formFields || []).length > 0 || (entity.formActions || []).length > 0
            ? [
                  ...(entity.formFields || []).map((field, fieldIndex) => ({
                      id: `auto_${id}_field_${fieldIndex}`,
                      type: 'field' as const,
                      businessKey: field.fieldKey,
                      ...(field.name ? { name: field.name } : {}),
                      target: buildNodeTarget(snapshot, field.controlNodeId),
                      expect: 'unique' as const,
                      origin: 'inferred' as const,
                      disposition: 'active' as const,
                  })),
                  ...(entity.formActions || []).map((action) => ({
                      id: `auto_${id}_action_${action.actionIntent}`,
                      type: 'action' as const,
                      businessKey: action.actionIntent,
                      ...(action.text ? {name: action.text} : {}),
                      target: buildNodeTarget(snapshot, action.nodeId, {allowText: true}),
                      expect: 'unique' as const,
                      origin: 'inferred' as const,
                      disposition: 'active' as const,
                  })),
              ]
            : inferredFields;

    const columns: CanvasEntityDraft['columns'] =
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
        })) || [];
    const inferredRowActions = inferRowActionsFromControls(snapshot, entity);
    if (inferredRowActions.length > 0) {
        let actionColumn = columns.find((column) =>
            column.kind === 'action_column' ||
            column.fieldKey.toLowerCase() === 'actions' ||
            column.fieldKey.includes('操作') ||
            column.name?.includes('操作'),
        );
        if (!actionColumn) {
            actionColumn = {
                id: `${id}_col_actions`,
                fieldKey: 'actions',
                name: '操作',
                kind: 'action_column',
                actions: [],
                origin: 'inferred',
                disposition: 'active',
            };
            columns.push(actionColumn);
        }
        const existingIntents = new Set(actionColumn.actions.map((action) => action.actionIntent));
        actionColumn.actions.push(...inferredRowActions.filter((action) => !existingIntents.has(action.actionIntent)));
        actionColumn.kind = 'action_column';
    }

    return {
        id,
        source: entity.type === 'group' ? 'group' : 'region',
        kind: entity.kind,
        name: normalizeText(entity.businessName || entity.name) || entity.id,
        businessTag: normalizeText(entity.businessTag) || `${entity.kind}.${entity.id}`,
        target: buildEntityTarget(entity),
        expect: 'unique',
        annotations,
        columns,
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
                      pageTarget: buildNodeTarget(
                          snapshot,
                          entity.pagination.nextAction.nodeId,
                          {allowText: true},
                      ),
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

const buildFreshInferredEntities = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
): CanvasEntityDraft[] => {
    const significantEntities = (finalEntityView?.entities || []).filter(isSignificantEntity);
    const inferredNodeIds = new Set<string>();
    const entities: CanvasEntityDraft[] = [];
    let autoIndex = 0;
    for (const record of significantEntities) {
        if (inferredNodeIds.has(record.nodeId)) {
            continue;
        }
        inferredNodeIds.add(record.nodeId);
        const inferred = buildInferredEntity(snapshot, record, autoIndex);
        autoIndex += 1;
        entities.push(inferred);
    }
    return entities;
};

const resolveSelectedRootNodeId = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
    selected: CanvasEntityDraft,
): string | null => {
    if (selected.source === 'node') {
        return countMatches(snapshot, selected.target)[0] ?? null;
    }
    const wantedName = normalizeText(selected.target.nameContains);
    const record = (finalEntityView?.entities || []).find((entity) => {
        if (entity.type !== selected.source || entity.kind !== selected.kind) {return false;}
        if (!wantedName) {return true;}
        return (normalizeText(entity.name) || '').includes(wantedName);
    });
    return record?.nodeId ?? null;
};

const mergeScopedAnnotations = (
    selected: CanvasEntityDraft['annotations'],
    inferred: CanvasEntityDraft['annotations'],
): CanvasEntityDraft['annotations'] => {
    const out = selected.map((item) => ({...item, target: {...item.target}}));
    const byKey = new Map(out.map((item, index) => [item.businessKey, index]));
    for (const item of inferred) {
        const index = byKey.get(item.businessKey);
        if (index === undefined) {
            byKey.set(item.businessKey, out.length);
            out.push({...item, target: {...item.target}});
        } else if (out[index].origin === 'inferred') {
            out[index] = {...out[index], ...item, id: out[index].id, target: {...item.target}};
        }
    }
    return out;
};

const mergeScopedColumns = (
    selected: CanvasEntityDraft['columns'],
    inferred: CanvasEntityDraft['columns'],
): CanvasEntityDraft['columns'] => {
    const out = selected.map((column) => ({
        ...column,
        actions: column.actions.map((action) => ({...action, target: {...action.target}})),
    }));
    const byKey = new Map(out.map((column, index) => [column.fieldKey, index]));
    for (const column of inferred) {
        const index = byKey.get(column.fieldKey);
        const cloned = {
            ...column,
            actions: column.actions.map((action) => ({...action, target: {...action.target}})),
        };
        if (index === undefined) {
            byKey.set(column.fieldKey, out.length);
            out.push(cloned);
        } else if (out[index].origin === 'inferred') {
            out[index] = {...out[index], ...cloned, id: out[index].id};
        }
    }
    return out;
};

const recognizeWithinSelectedEntity = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
    existingDraft: CanvasDraft,
): {canvasDraft: CanvasDraft; recognized: RecognizedItem[]} => {
    const selected = existingDraft.entities[0];
    const rootNodeId = resolveSelectedRootNodeId(snapshot, finalEntityView, selected);
    if (!rootNodeId) {
        return {
            canvasDraft: existingDraft,
            recognized: [summarizeEntity(selected, 'existing')],
        };
    }
    const parentById = buildParentById(snapshot.root);
    const records = (finalEntityView?.entities || [])
        .filter(isSignificantEntity)
        .filter((record) => isDescendantOrSelf(record.nodeId, rootNodeId, parentById));
    const inferred = records.map((record, index) => buildInferredEntity(snapshot, record, index));
    const unclaimed = inferUnclaimedScopeControls(
        snapshot,
        rootNodeId,
        records
            .filter((record) => record.kind === 'table' || record.kind === 'list')
            .map((record) => record.nodeId),
    );
    const annotations = mergeScopedAnnotations(
        selected.annotations,
        [
            ...inferred.flatMap((entity) => entity.annotations),
            ...unclaimed.annotations,
        ],
    );
    const columns = mergeScopedColumns(
        selected.columns,
        inferred.flatMap((entity) => entity.columns),
    );
    const primaryKey = selected.primaryKey ?? inferred.find((entity) => entity.primaryKey)?.primaryKey;
    const pagination = selected.pagination ??
        inferred.find((entity) => entity.pagination)?.pagination ??
        unclaimed.pagination;
    const entity: CanvasEntityDraft = {
        ...selected,
        target: {...selected.target},
        annotations,
        columns,
        ...(primaryKey ? {primaryKey} : {}),
        ...(pagination ? {pagination: {...pagination, pageTarget: {...pagination.pageTarget}}} : {}),
    };
    const canvasDraft: CanvasDraft = {
        ...existingDraft,
        entities: [entity],
    };
    return {
        canvasDraft,
        recognized: [summarizeEntity(entity, 'existing')],
    };
};

const buildPageFallbackEntity = (
    snapshot: SnapshotResult,
    pageKind: EntityKind,
): CanvasEntityDraft => {
    const rootRole = normalizeText(snapshot.root.role) || 'root';
    const pageName = normalizeText(snapshot.root.name) || `页面${pageKind === 'form' ? '表单' : '实体'}`;
    return {
        id: entityCanvasId(0),
        source: 'node',
        kind: pageKind,
        name: pageName,
        businessTag: `${pageKind}.page`,
        target: {roleEquals: rootRole},
        expect: 'unique',
        annotations: [],
        columns: [],
        origin: 'inferred',
    };
};

export const recognizeEntities = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
    existingDraft?: CanvasDraft,
): { canvasDraft: CanvasDraft; recognized: RecognizedItem[] } => {
    if (existingDraft?.entities.length === 1 && existingDraft.entities[0].origin === 'manual') {
        return recognizeWithinSelectedEntity(snapshot, finalEntityView, existingDraft);
    }
    const pageKind = existingDraft?.page.kind || inferPageKind(finalEntityView);
    const page: CanvasPageDraft = existingDraft?.page || { kind: pageKind };

    const inferredEntities = buildFreshInferredEntities(snapshot, finalEntityView);
    const hasPageKindEntity = inferredEntities.some((entity) => entity.kind === pageKind);
    const freshEntities = hasPageKindEntity
        ? inferredEntities
        : [
              buildPageFallbackEntity(snapshot, pageKind),
              ...inferredEntities.map((entity, index) => ({...entity, id: entityCanvasId(index + 1)})),
          ];
    const { draft: canvasDraft } = protectiveMerge(existingDraft, freshEntities, page);

    const existingTags = new Set(
        (existingDraft?.entities || []).map((entity) => entity.businessTag),
    );
    const recognized: RecognizedItem[] = canvasDraft.entities.map((entity) =>
        summarizeEntity(
            entity,
            existingTags.has(entity.businessTag) ? 'existing' : 'inferred',
        ),
    );

    return { canvasDraft, recognized };
};
