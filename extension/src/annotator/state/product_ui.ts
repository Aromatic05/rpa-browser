import type {AnnotationBox} from '../layout/annotation_boxes.js';
import {entityVisualId, paginationPageVisualId} from '../visual_ids.js';
import type {
    CanvasColumnDraft,
    CanvasEffectDraft,
    CanvasEffectReversibility,
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
    const fields = entity.annotations.filter((item) =>
        item.type === 'field' && item.disposition === 'active').length;
    const queryActions = entity.annotations.filter((item) =>
        item.type === 'action' && item.disposition === 'active').length;
    const rowActions = entity.columns.reduce((sum, column) =>
        sum + column.actions.filter((action) => action.disposition === 'active').length, 0);
    const columns = entity.columns.filter((column) => column.disposition === 'active').length;
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
    origin: CanvasEntityDraft['origin'];
    disposition: 'active' | 'ignored';
    validation: CheckResultByAnnotation['status'] | 'unchecked';
    canReselect: boolean;
};

const annotationRoleLabel = (entity: CanvasEntityDraft, type: 'field' | 'action'): string => {
    if (entity.kind === 'table') {return type === 'field' ? '筛选字段' : '列表操作';}
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
            roleLabel: '分页',
            name: '下一页',
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
            {type: 'action', label: '添加列表操作', description: '用于查询、下载等列表级操作'},
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

export type BusinessChoice = {value: string; label: string};

export type BusinessObjectEditPatch = {
    name?: string;
    fieldKey?: string;
    actionIntent?: string;
    columnKind?: NonNullable<CanvasColumnDraft['kind']>;
    primaryKey?: boolean;
    effect?: CanvasEffectDraft;
};

export const businessFieldBindingOptions = (entity: CanvasEntityDraft | null): BusinessChoice[] =>
    entity?.columns
        .filter((column) => column.disposition === 'active' && column.kind !== 'action_column' && column.actions.length === 0)
        .map((column) => ({
            value: column.fieldKey,
            label: column.name?.trim() || column.fieldKey,
        })) ?? [];

export const businessColumnKindOptions = (): BusinessChoice[] => [
    {value: 'text', label: '文本'},
    {value: 'number', label: '数字'},
    {value: 'date', label: '日期时间'},
    {value: 'status', label: '状态'},
    {value: 'action_column', label: '操作列'},
];

export const recognitionGuideMessage = (entity: CanvasEntityDraft | null): string => {
    if (entity?.kind === 'table' && !entity.primaryKey) {
        return '识别完成，请选择主键列并检查遗漏项。';
    }
    return '识别完成，请检查遗漏项后保存。';
};

export const businessActionIntentOptions = (
    entity: CanvasEntityDraft | null,
    role: 'action' | 'row_action',
    currentValue: string,
    currentLabel: string,
): BusinessChoice[] => {
    const options = role === 'row_action'
        ? [
            {value: 'view', label: '查看'},
            {value: 'edit', label: '编辑'},
            {value: 'delete', label: '删除'},
            {value: 'confirm', label: '确认'},
            {value: 'approve', label: '通过'},
            {value: 'reject', label: '拒绝'},
        ]
        : entity?.kind === 'form'
            ? [
                {value: 'submit', label: '提交'},
                {value: 'save', label: '保存'},
                {value: 'cancel', label: '取消'},
                {value: 'next', label: '下一步'},
                {value: 'previous', label: '上一步'},
            ]
            : [
                {value: 'search', label: '查询'},
                {value: 'reset', label: '重置条件'},
                {value: 'export', label: '导出列表'},
                {value: 'refresh', label: '刷新列表'},
                {value: 'create', label: '新增记录'},
            ];
    if (currentValue && !options.some((option) => option.value === currentValue)) {
        return [{value: currentValue, label: currentLabel || '当前操作'}, ...options];
    }
    return options;
};

export type BusinessEffectChoice = BusinessChoice & {
    hint: string;
};

const effectChoiceByReversibility: Record<CanvasEffectReversibility, BusinessEffectChoice> = {
    unknown: {
        value: 'unknown',
        label: '不确定',
        hint: '按保守策略处理：运行时不会假定此操作可以恢复。',
    },
    reversible: {
        value: 'reversible',
        label: '可以撤销',
        hint: '在已声明的语义范围内，运行时可以退回该操作执行前的状态。',
    },
    compensatable: {
        value: 'compensatable',
        label: '可业务抵偿',
        hint: '存在反向业务操作可以抵偿（例如冲销），但不保证恢复原始状态。',
    },
    irreversible: {
        value: 'irreversible',
        label: '不可撤销',
        hint: '执行后无法撤销；运行到此处前需要人工确认。',
    },
};

export const businessEffectChoices = (): BusinessEffectChoice[] =>
    ['unknown', 'reversible', 'compensatable', 'irreversible']
        .map((value) => effectChoiceByReversibility[value as CanvasEffectReversibility]);

export const normalizeBusinessEffect = (effect: CanvasEffectDraft | undefined): CanvasEffectReversibility =>
    effect?.reversibility ?? 'unknown';

export type BusinessEffectRole = 'field' | 'action' | 'row_action';

export const showsBusinessEffectEditor = (
    entity: CanvasEntityDraft | null,
    role: BusinessEffectRole,
): boolean => {
    if (!entity) {return false;}
    if (role === 'action' || role === 'row_action') {return true;}
    return entity.kind === 'form';
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
