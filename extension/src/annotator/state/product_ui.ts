import type {AnnotationBox} from '../layout/annotation_boxes.js';
import {entityVisualId, paginationPageVisualId} from '../visual_ids.js';
import type {
    CanvasEntityDraft,
    CheckResultByAnnotation,
    PickCandidate,
    PickPurpose,
} from '../types.js';

export type AnnotatorProductStage = 'scope' | 'recognize' | 'review' | 'edit';

export type CanvasPresentation = {
    dimOutsideEntity: boolean;
    showEntity: boolean;
    showObjects: boolean;
    showLabels: boolean;
    showEditor: boolean;
};

export const deriveCanvasPresentation = (
    stage: AnnotatorProductStage,
    pickMode: boolean,
    hasEntity: boolean,
): CanvasPresentation => {
    if (!hasEntity || stage === 'scope') {
        return {
            dimOutsideEntity: false,
            showEntity: false,
            showObjects: false,
            showLabels: false,
            showEditor: false,
        };
    }
    const inspectable = !pickMode && (stage === 'review' || stage === 'edit');
    return {
        dimOutsideEntity: true,
        showEntity: true,
        showObjects: inspectable,
        showLabels: inspectable,
        showEditor: inspectable,
    };
};

const KIND_COLOR: Record<AnnotationBox['kind'], string> = {
    entity: '#2563eb',
    field: '#16a34a',
    action: '#ea580c',
    column: '#7c3aed',
    pagination: '#0f766e',
};

export type AnnotationVisualState = {
    status: 'inferred' | 'confirmed' | 'error' | 'ignored';
    dashed: boolean;
    color: string;
};

export const annotationVisualState = (
    box: AnnotationBox,
    check: CheckResultByAnnotation | null,
): AnnotationVisualState => {
    if (box.disposition === 'ignored') {
        return {status: 'ignored', dashed: true, color: '#94a3b8'};
    }
    const broken = check && (
        check.status === 'missing' ||
        check.status === 'invalid' ||
        (check.status === 'multiple' && check.expected === 'unique')
    );
    if (broken) {
        return {status: 'error', dashed: false, color: '#dc2626'};
    }
    if (box.origin === 'inferred') {
        return {status: 'inferred', dashed: true, color: KIND_COLOR[box.kind]};
    }
    return {status: 'confirmed', dashed: false, color: KIND_COLOR[box.kind]};
};

export const deriveProductStage = (input: {
    hasDraft: boolean;
    hasObjects: boolean;
    hasArtifact: boolean;
    reviewPending: boolean;
}): AnnotatorProductStage => {
    if (!input.hasDraft) {return 'scope';}
    if (!input.hasObjects) {return 'recognize';}
    if (!input.hasArtifact && input.reviewPending) {return 'review';}
    return 'edit';
};

export type EntityObjectSummary = {
    fields: number;
    queryActions: number;
    columns: number;
    rowActions: number;
    pagination: number;
    total: number;
};

export const summarizeEntityDraft = (entity: CanvasEntityDraft | null): EntityObjectSummary => {
    if (!entity) {
        return {fields: 0, queryActions: 0, columns: 0, rowActions: 0, pagination: 0, total: 0};
    }
    const fields = entity.annotations.filter((item) => item.type === 'field').length;
    const queryActions = entity.annotations.filter((item) => item.type === 'action').length;
    const rowActions = entity.columns.reduce((sum, column) => sum + column.actions.length, 0);
    const columns = entity.columns.length;
    const pagination = entity.pagination ? 1 : 0;
    return {
        fields,
        queryActions,
        columns,
        rowActions,
        pagination,
        total: fields + queryActions + columns + rowActions + pagination,
    };
};

export type BusinessObjectRole =
    | 'field'
    | 'action'
    | 'column'
    | 'row_action'
    | 'pagination';

export type BusinessObjectItem = {
    annotationId: string;
    role: BusinessObjectRole;
    roleLabel: string;
    name: string;
    businessKey: string;
    origin: CanvasEntityDraft['origin'];
    disposition: 'active' | 'ignored';
    validation: CheckResultByAnnotation['status'] | 'unchecked';
    canReselect: boolean;
};

const annotationRoleLabel = (entity: CanvasEntityDraft, type: 'field' | 'action'): string => {
    if (entity.kind === 'table') {return type === 'field' ? '筛选字段' : '区域操作';}
    if (entity.kind === 'form') {return type === 'field' ? '表单字段' : '表单操作';}
    return type === 'field' ? '字段' : '操作';
};

export const listEntityBusinessObjects = (
    entity: CanvasEntityDraft | null,
    checks: readonly CheckResultByAnnotation[] | null = null,
): BusinessObjectItem[] => {
    if (!entity) {return [];}
    const validation = new Map((checks ?? []).map((item) => [item.canvasAnnotationId, item.status]));
    const result: BusinessObjectItem[] = [];
    for (const annotation of entity.annotations) {
        if (annotation.type === 'pagination') {continue;}
        result.push({
            annotationId: annotation.id,
            role: annotation.type,
            roleLabel: annotationRoleLabel(entity, annotation.type),
            name: annotation.name?.trim() || annotation.businessKey,
            businessKey: annotation.businessKey,
            origin: annotation.origin,
            disposition: annotation.disposition,
            validation: validation.get(annotation.id) ?? 'unchecked',
            canReselect: true,
        });
    }
    for (const column of entity.columns) {
        result.push({
            annotationId: column.id,
            role: 'column',
            roleLabel: '表格列',
            name: column.name?.trim() || column.fieldKey,
            businessKey: column.fieldKey,
            origin: column.origin,
            disposition: column.disposition,
            validation: validation.get(column.id) ?? 'unchecked',
            canReselect: false,
        });
        for (const action of column.actions) {
            result.push({
                annotationId: action.id,
                role: 'row_action',
                roleLabel: '行操作',
                name: action.text?.trim() || action.actionIntent,
                businessKey: action.actionIntent,
                origin: action.origin,
                disposition: action.disposition,
                validation: validation.get(action.id) ?? 'unchecked',
                canReselect: true,
            });
        }
    }
    if (entity.pagination) {
        const annotationId = paginationPageVisualId(entity.id);
        result.push({
            annotationId,
            role: 'pagination',
            roleLabel: '翻页操作',
            name: '下一页',
            businessKey: entity.pagination.actionIntent,
            origin: entity.origin,
            disposition: 'active',
            validation: validation.get(annotationId) ?? 'unchecked',
            canReselect: true,
        });
    }
    return result;
};

export type BusinessObjectAddOption = {
    type: 'field' | 'action';
    label: string;
    description: string;
};

export const businessObjectAddOptions = (entity: CanvasEntityDraft | null): BusinessObjectAddOption[] => {
    if (!entity) {return [];}
    if (entity.kind === 'table') {
        return [
            {type: 'field', label: '添加筛选字段', description: '用于向列表筛选条件输入内容'},
            {type: 'action', label: '添加区域操作', description: '用于查询、下载等列表级操作'},
        ];
    }
    if (entity.kind === 'form') {
        return [
            {type: 'field', label: '添加表单字段', description: '用于填写或选择表单值'},
            {type: 'action', label: '添加表单操作', description: '用于提交、保存等表单操作'},
        ];
    }
    return [
        {type: 'field', label: '添加字段', description: '用于读取或填写页面内容'},
        {type: 'action', label: '添加操作', description: '用于点击页面操作'},
    ];
};

export type AnnotationBoxGroups = {
    fields: AnnotationBox[];
    actions: AnnotationBox[];
    columns: AnnotationBox[];
    pagination: AnnotationBox[];
};

export const groupAnnotationBoxes = (boxes: AnnotationBox[]): AnnotationBoxGroups => ({
    fields: boxes.filter((item) => item.kind === 'field'),
    actions: boxes.filter((item) => item.kind === 'action'),
    columns: boxes.filter((item) => item.kind === 'column'),
    pagination: boxes.filter((item) => item.kind === 'pagination'),
});

const fallbackByLevel: Record<PickCandidate['level'], string> = {
    control: '操作',
    field: '字段',
    row: '数据行',
    group: '业务区域',
    region: '业务区域',
    unknown: '页面对象',
};

export const candidateDisplayName = (
    candidate: PickCandidate | null,
    purpose: PickPurpose,
): string => {
    if (!candidate) {return purpose === 'entity' ? '业务区域' : '页面对象';}
    const text = candidate.text?.replace(/\s+/g, ' ').trim();
    if (text) {return text.length > 28 ? `${text.slice(0, 28)}…` : text;}
    if (purpose === 'entity') {return '业务区域';}
    return fallbackByLevel[candidate.level];
};

export type CheckIssueRecovery =
    | {kind: 'entity'; entityId: string; annotationId: string}
    | {kind: 'item'; entityId: string; annotationId: string}
    | null;

export const resolveCheckIssueRecovery = (
    entities: readonly CanvasEntityDraft[],
    issue: CheckResultByAnnotation | null,
): CheckIssueRecovery => {
    if (!issue) {return null;}
    for (const entity of entities) {
        if (issue.canvasAnnotationId === entityVisualId(entity.id)) {
            return {kind: 'entity', entityId: entity.id, annotationId: issue.canvasAnnotationId};
        }
        if (entity.annotations.some((annotation) => annotation.id === issue.canvasAnnotationId)) {
            return {kind: 'item', entityId: entity.id, annotationId: issue.canvasAnnotationId};
        }
        if (entity.columns.some((column) =>
            column.actions.some((action) => action.id === issue.canvasAnnotationId))) {
            return {kind: 'item', entityId: entity.id, annotationId: issue.canvasAnnotationId};
        }
        if (issue.canvasAnnotationId === paginationPageVisualId(entity.id)) {
            return {kind: 'item', entityId: entity.id, annotationId: issue.canvasAnnotationId};
        }
    }
    return null;
};

export const checkIssueMessage = (
    stale: boolean,
    issue: CheckResultByAnnotation | null,
    label: string | null,
): string | null => {
    if (stale) {
        return '页面内容已经变化。请重新识别后再保存。';
    }
    if (!issue) {return null;}
    const name = label || '这个对象';
    if (issue.status === 'missing') {
        return `“${name}”未能在页面中找到，请重新选择它的位置。`;
    }
    if (issue.status === 'multiple' && issue.expected === 'unique') {
        return `“${name}”匹配到多个对象，请缩小选择范围。`;
    }
    if (issue.status === 'invalid') {
        return `“${name}”的标注无效，请重新选择或检查高级设置。`;
    }
    return null;
};
