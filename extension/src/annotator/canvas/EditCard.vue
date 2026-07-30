<script setup lang="ts">
import {computed} from 'vue';
import type {
    CanvasAnnotationDraft,
    CanvasColumnDraft,
    CanvasEntityDraft,
    PickCandidate,
} from '../types.js';
import type {AnnotationBoxKind} from '../layout/annotation_boxes.js';
import {
    businessActionIntentOptions,
    businessColumnKindOptions,
    businessFieldBindingOptions,
} from '../state/product_ui.js';

const props = defineProps<{
    annotation: CanvasAnnotationDraft | null;
    annotationKind: AnnotationBoxKind | null;
    entity: CanvasEntityDraft | null;
    candidate: PickCandidate | null;
    candidateIndex: number;
    candidateChainLength: number;
    canDelete: boolean;
    canReselect: boolean;
    canIgnore: boolean;
    canSetPrimaryKey: boolean;
    isPrimaryKey: boolean;
}>();

const emit = defineEmits<{
    (e: 'updateName', name: string): void;
    (e: 'bindField', fieldKey: string): void;
    (e: 'setActionIntent', actionIntent: string): void;
    (e: 'setColumnKind', kind: NonNullable<CanvasColumnDraft['kind']>): void;
    (e: 'reselect'): void;
    (e: 'outer'): void;
    (e: 'inner'): void;
    (e: 'delete'): void;
    (e: 'ignore'): void;
    (e: 'setPrimaryKey', selected: boolean): void;
    (e: 'close'): void;
}>();

const selectedColumn = computed(() =>
    props.entity?.columns.find((column) => column.id === props.annotation?.id) ?? null,
);
const selectedRowAction = computed(() =>
    props.entity?.columns.flatMap((column) => column.actions)
        .find((action) => action.id === props.annotation?.id) ?? null,
);
const isNativeField = computed(() =>
    props.annotationKind === 'field' && props.annotation?.type === 'field' && !selectedColumn.value,
);
const isAction = computed(() => props.annotationKind === 'action');
const isPagination = computed(() => props.annotationKind === 'pagination');

const typeLabel = computed(() => {
    if (props.annotationKind === 'column') {return '表格列';}
    if (isPagination.value) {return '翻页';}
    if (selectedRowAction.value) {return '行操作';}
    if (props.entity?.kind === 'table' && isNativeField.value) {return '筛选字段';}
    if (props.entity?.kind === 'table' && isAction.value) {return '列表操作';}
    if (props.entity?.kind === 'form' && isNativeField.value) {return '表单字段';}
    if (props.entity?.kind === 'form' && isAction.value) {return '表单操作';}
    return isAction.value ? '操作' : '字段';
});

const displayName = computed(() => {
    if (isPagination.value) {return '分页控件';}
    return props.annotation?.name?.trim() || typeLabel.value;
});
const nameModel = computed({
    get: () => props.annotation?.name ?? '',
    set: (value: string) => emit('updateName', value),
});
const fieldBindingOptions = computed(() => {
    const options = businessFieldBindingOptions(props.entity);
    const currentValue = props.annotation?.businessKey ?? '';
    if (currentValue && !options.some((option) => option.value === currentValue)) {
        return [{value: currentValue, label: props.annotation?.name?.trim() || '当前字段'}, ...options];
    }
    return options;
});
const fieldBindingModel = computed({
    get: () => props.annotation?.businessKey ?? '',
    set: (value: string) => emit('bindField', value),
});
const columnKindOptions = businessColumnKindOptions();
const columnKindModel = computed({
    get: () => selectedColumn.value?.kind ?? (selectedColumn.value?.actions.length ? 'action_column' : 'text'),
    set: (value: NonNullable<CanvasColumnDraft['kind']>) => emit('setColumnKind', value),
});
const actionIntentOptions = computed(() => businessActionIntentOptions(
    props.entity,
    selectedRowAction.value ? 'row_action' : 'action',
    selectedRowAction.value?.actionIntent ?? props.annotation?.businessKey ?? '',
    props.annotation?.name ?? '',
));
const actionIntentModel = computed({
    get: () => selectedRowAction.value?.actionIntent ?? props.annotation?.businessKey ?? '',
    set: (value: string) => emit('setActionIntent', value),
});

const canNavigateOuter = computed(() => props.candidateIndex < props.candidateChainLength - 1);
const canNavigateInner = computed(() => props.candidateIndex > 0);
</script>

<template>
    <section class="canvas-edit-card annotator-edit-card" data-rpa-snapshot-ignore="true">
        <header>
            <div>
                <span>{{ typeLabel }}</span>
                <strong>{{ displayName }}</strong>
            </div>
            <button type="button" class="close-card" aria-label="关闭编辑卡片" @click="emit('close')">×</button>
        </header>

        <label v-if="!isPagination" class="business-field">
            <span>名称</span>
            <input v-model="nameModel" type="text" />
        </label>

        <label v-if="isNativeField && entity?.kind === 'table' && fieldBindingOptions.length" class="business-field">
            <span>对应表格列</span>
            <select v-model="fieldBindingModel">
                <option v-for="option in fieldBindingOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                </option>
            </select>
        </label>

        <label v-if="annotationKind === 'column'" class="business-field">
            <span>内容类型</span>
            <select v-model="columnKindModel">
                <option v-for="option in columnKindOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                </option>
            </select>
        </label>

        <label v-if="isAction" class="business-field">
            <span>作用</span>
            <select v-model="actionIntentModel">
                <option v-for="option in actionIntentOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                </option>
            </select>
        </label>

        <button
            v-if="canSetPrimaryKey"
            type="button"
            class="primary-key-choice"
            :class="{active: isPrimaryKey}"
            :aria-pressed="isPrimaryKey"
            @click="emit('setPrimaryKey', !isPrimaryKey)"
        >
            <span class="primary-key-icon">KEY</span>
            <span class="primary-key-copy">
                <strong>主键列</strong>
                <small>用于唯一识别表格中的一行数据</small>
            </span>
            <span class="primary-key-switch" aria-hidden="true"><i></i></span>
        </button>

        <div v-if="candidateChainLength > 1" class="range-actions">
            <button type="button" :disabled="!canNavigateInner" @click="emit('inner')">缩小范围</button>
            <button type="button" :disabled="!canNavigateOuter" @click="emit('outer')">扩大范围</button>
        </div>

        <footer>
            <div>
                <button v-if="canReselect" type="button" class="secondary" @click="emit('reselect')">重新选择位置</button>
                <button v-if="canIgnore" type="button" class="secondary" @click="emit('ignore')">不使用</button>
            </div>
            <button v-if="canDelete" type="button" class="danger" @click="emit('delete')">删除</button>
        </footer>
    </section>
</template>

<style scoped>
.canvas-edit-card {
    display: grid;
    gap: 10px;
    color: #0f172a;
    font-size: 12px;
}
.canvas-edit-card header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
}
.canvas-edit-card header > div { min-width: 0; }
.canvas-edit-card header span {
    display: block;
    margin-bottom: 2px;
    color: #64748b;
    font-size: 10px;
    font-weight: 700;
}
.canvas-edit-card header strong {
    display: block;
    overflow: hidden;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.close-card {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
}
.close-card:hover { background: #f1f5f9; }
.business-field { display: grid; gap: 5px; }
.business-field > span { color: #475569; font-size: 10px; font-weight: 700; }
.business-field input,
.business-field select {
    width: 100%;
    min-width: 0;
    height: 36px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 0 9px;
    outline: none;
    background: #fff;
    color: #0f172a;
    font: inherit;
}
.business-field input:focus,
.business-field select:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, .12);
}
.primary-key-choice {
    width: 100%;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 9px;
    align-items: center;
    min-height: 48px;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 8px 9px;
    background: #fff;
    color: #334155;
    text-align: left;
    cursor: pointer;
}
.primary-key-choice.active { border-color: #f59e0b; background: #fffbeb; }
.primary-key-icon {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: #f1f5f9;
    color: #64748b;
    font-size: 9px;
    font-weight: 800;
}
.primary-key-choice.active .primary-key-icon { background: #fef3c7; color: #92400e; }
.primary-key-copy { min-width: 0; }
.primary-key-copy strong,
.primary-key-copy small { display: block; }
.primary-key-copy strong { font-size: 11px; }
.primary-key-copy small { margin-top: 2px; color: #64748b; font-size: 9px; }
.primary-key-switch {
    width: 30px;
    height: 18px;
    padding: 2px;
    border-radius: 999px;
    background: #cbd5e1;
}
.primary-key-switch i {
    display: block;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: transform 120ms ease;
}
.primary-key-choice.active .primary-key-switch { background: #f59e0b; }
.primary-key-choice.active .primary-key-switch i { transform: translateX(12px); }
.range-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 5px;
    padding: 4px;
    border-radius: 9px;
    background: #f1f5f9;
}
.range-actions button {
    min-height: 32px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #475569;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
}
.range-actions button:disabled { opacity: .35; cursor: default; }
.canvas-edit-card footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 2px;
}
.canvas-edit-card footer > div { display: flex; gap: 6px; }
.canvas-edit-card footer button {
    min-height: 32px;
    border-radius: 8px;
    padding: 0 10px;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
}
.secondary { border: 1px solid #cbd5e1; background: #fff; color: #334155; }
.danger { border: 1px solid #fecaca; background: #fff7f7; color: #b91c1c; }
</style>
