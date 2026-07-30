<script setup lang="ts">
import {computed} from 'vue';
import type {
    CanvasAnnotationDraft,
    CanvasAnnotationType,
    CanvasEntityDraft,
    PickCandidate,
} from '../types.js';
import type {RecommendedType} from '../recommend/recommend_types.js';
import type {AnnotationBoxKind} from '../layout/annotation_boxes.js';

const props = defineProps<{
    annotation: CanvasAnnotationDraft | null;
    annotationKind: AnnotationBoxKind | null;
    entity: CanvasEntityDraft | null;
    candidate: PickCandidate | null;
    candidateIndex: number;
    candidateChainLength: number;
    canChangeType: boolean;
    canDelete: boolean;
    canReselect: boolean;
    canIgnore: boolean;
    canSetPrimaryKey: boolean;
    isPrimaryKey: boolean;
}>();

const emit = defineEmits<{
    (e: 'update', patch: Partial<CanvasAnnotationDraft>): void;
    (e: 'reselect'): void;
    (e: 'outer'): void;
    (e: 'inner'): void;
    (e: 'delete'): void;
    (e: 'ignore'): void;
    (e: 'chooseType', type: RecommendedType): void;
    (e: 'setPrimaryKey', selected: boolean): void;
    (e: 'close'): void;
}>();

const annotationTypes = computed<Array<{value: CanvasAnnotationType; label: string}>>(() => {
    if (props.entity?.kind === 'table') {
        return [
            {value: 'field', label: '筛选字段'},
            {value: 'action', label: '区域操作'},
        ];
    }
    if (props.entity?.kind === 'form') {
        return [
            {value: 'field', label: '表单字段'},
            {value: 'action', label: '表单操作'},
        ];
    }
    return [
        {value: 'field', label: '字段'},
        {value: 'action', label: '操作'},
    ];
});

const nameModel = computed({
    get: () => props.annotation?.name ?? '',
    set: (value: string) => emit('update', {name: value}),
});

const businessKeyModel = computed({
    get: () => props.annotation?.businessKey ?? '',
    set: (value: string) => emit('update', {businessKey: value}),
});

const typeModel = computed({
    get: () => props.annotation?.type ?? 'field',
    set: (value: CanvasAnnotationType) => emit('update', {type: value}),
});

const canNavigateOuter = computed(() => props.candidateIndex < props.candidateChainLength - 1);
const canNavigateInner = computed(() => props.candidateIndex > 0);
const typeLabel = computed(() => {
    if (props.annotationKind === 'entity') {return '业务区域';}
    if (props.annotationKind === 'column') {return '表格列';}
    if (props.annotationKind === 'pagination') {return '翻页';}
    if (props.entity?.kind === 'table' && typeModel.value === 'field') {return '筛选字段';}
    if (props.entity?.kind === 'table' && typeModel.value === 'action') {return '区域操作';}
    return annotationTypes.value.find((item) => item.value === typeModel.value)?.label ?? '对象';
});
</script>

<template>
    <section class="canvas-edit-card annotator-edit-card" data-rpa-snapshot-ignore="true">
        <header>
            <div>
                <span>{{ typeLabel }}</span>
                <strong>{{ annotation?.name || annotation?.businessKey || '未命名对象' }}</strong>
            </div>
            <button type="button" class="close-card" aria-label="关闭编辑卡片" @click="emit('close')">×</button>
        </header>

        <div class="card-fields">
            <label>
                <span>业务名称</span>
                <input v-model="nameModel" type="text" placeholder="例如：采购人" />
            </label>
            <label>
                <span>业务标识</span>
                <input v-model="businessKeyModel" type="text" placeholder="buyer" />
            </label>
        </div>

        <div v-if="canChangeType" class="type-choice" aria-label="对象类型">
            <button
                v-for="item in annotationTypes"
                :key="item.value"
                type="button"
                :class="{active: typeModel === item.value}"
                @click="typeModel = item.value"
            >{{ item.label }}</button>
        </div>

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
            <button type="button" :disabled="!canNavigateInner" @click="emit('inner')">选择内部</button>
            <button type="button" :disabled="!canNavigateOuter" @click="emit('outer')">选择外层</button>
        </div>

        <footer>
            <div>
                <button v-if="canReselect" type="button" class="secondary" @click="emit('reselect')">重新选择位置</button>
                <button v-if="canIgnore" type="button" class="secondary" @click="emit('ignore')">忽略</button>
            </div>
            <button v-if="canDelete" type="button" class="danger" @click="emit('delete')">删除</button>
        </footer>
    </section>
</template>

<style scoped>
.canvas-edit-card {
    display: grid;
    gap: 11px;
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
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
}
.close-card:hover { background: #f1f5f9; }
.card-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}
.card-fields label { display: grid; gap: 4px; min-width: 0; }
.card-fields label > span { color: #475569; font-size: 10px; font-weight: 700; }
.card-fields input {
    width: 100%;
    min-width: 0;
    height: 34px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 0 9px;
    outline: none;
    background: #fff;
    color: #0f172a;
    font: inherit;
}
.card-fields input:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, .12);
}
.type-choice,
.range-actions {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 5px;
    padding: 4px;
    border-radius: 9px;
    background: #f1f5f9;
}
.range-actions { grid-template-columns: 1fr 1fr; }
.type-choice button,
.range-actions button {
    min-height: 30px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #475569;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
}
.type-choice button.active {
    background: #fff;
    color: #1d4ed8;
    box-shadow: 0 1px 4px rgba(15, 23, 42, .12);
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
.primary-key-choice.active {
    border-color: #f59e0b;
    background: #fffbeb;
}
.primary-key-icon {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: #f1f5f9;
    color: #64748b;
    font-size: 8px;
    font-weight: 900;
    letter-spacing: .04em;
}
.primary-key-choice.active .primary-key-icon { background: #fef3c7; color: #92400e; }
.primary-key-copy strong { display: block; font-size: 10px; }
.primary-key-copy small { display: block; margin-top: 2px; color: #94a3b8; font-size: 8px; }
.primary-key-switch {
    position: relative;
    width: 28px;
    height: 16px;
    border-radius: 999px;
    background: #cbd5e1;
    transition: background .15s ease;
}
.primary-key-switch i {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(15, 23, 42, .28);
    transition: transform .15s ease;
}
.primary-key-choice.active .primary-key-switch { background: #f59e0b; }
.primary-key-choice.active .primary-key-switch i { transform: translateX(12px); }
.range-actions button:hover:not(:disabled),
.type-choice button:hover { background: rgba(255, 255, 255, .75); }
.range-actions button:disabled { opacity: .35; cursor: default; }
.canvas-edit-card footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 1px;
}
.canvas-edit-card footer > div { display: flex; gap: 6px; }
.canvas-edit-card footer button {
    min-height: 30px;
    border-radius: 8px;
    padding: 0 9px;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
}
.secondary { border: 1px solid #cbd5e1; background: #fff; color: #334155; }
.secondary:hover { background: #f8fafc; }
.danger { border: 1px solid #fecdd3; background: #fff; color: #be123c; }
.danger:hover { background: #fff1f2; }
@media (max-width: 420px) {
    .card-fields { grid-template-columns: 1fr; }
}
</style>
