<script setup lang="ts">
import {computed} from 'vue';
import type {
    CanvasAnnotationDraft,
    CanvasAnnotationType,
    CanvasEntityDraft,
    PickCandidate,
} from '../types.js';
import type {RecommendedType} from '../recommend/recommend_types.js';

const props = defineProps<{
    annotation: CanvasAnnotationDraft | null;
    entity: CanvasEntityDraft | null;
    candidate: PickCandidate | null;
    candidateIndex: number;
    candidateChainLength: number;
    canChangeType: boolean;
    canDelete: boolean;
    canIgnore: boolean;
}>();

const emit = defineEmits<{
    (e: 'update', patch: Partial<CanvasAnnotationDraft>): void;
    (e: 'reselect'): void;
    (e: 'outer'): void;
    (e: 'inner'): void;
    (e: 'delete'): void;
    (e: 'ignore'): void;
    (e: 'chooseType', type: RecommendedType): void;
}>();

const ANNOTATION_TYPES: Array<{value: CanvasAnnotationType; label: string}> = [
    {value: 'field', label: '字段'},
    {value: 'action', label: '操作'},
    {value: 'pagination', label: '分页'},
];

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
const typeLabel = computed(() => ANNOTATION_TYPES.find((item) => item.value === typeModel.value)?.label ?? '对象');
</script>

<template>
    <div class="object-inspector annotator-edit-card" data-rpa-snapshot-ignore="true">
        <div class="object-inspector-heading">
            <div>
                <span>{{ typeLabel }}</span>
                <strong>{{ annotation?.name || annotation?.businessKey || '未命名对象' }}</strong>
            </div>
            <button type="button" class="location-action" @click="emit('reselect')">
                重新选择位置
            </button>
        </div>

        <label class="form-field annotator-edit-row">
            <span>显示名称</span>
            <input
                v-model="nameModel"
                class="product-input annotator-edit-input"
                type="text"
                placeholder="例如：订单编号"
            />
            <small>显示在标注标签和对象列表中。</small>
        </label>

        <div v-if="candidateChainLength > 1" class="range-adjustment">
            <span>当前选择范围不准确？</span>
            <div>
                <button type="button" :disabled="!canNavigateInner" @click="emit('inner')">缩小范围</button>
                <button type="button" :disabled="!canNavigateOuter" @click="emit('outer')">扩大范围</button>
            </div>
        </div>

        <details class="advanced-settings">
            <summary>
                <span>高级设置</span>
                <small>标识与对象类型</small>
            </summary>
            <div class="advanced-settings-content">
                <label class="form-field annotator-edit-row">
                    <span>内部标识</span>
                    <input
                        v-model="businessKeyModel"
                        class="product-input annotator-edit-input"
                        type="text"
                        placeholder="order_no"
                    />
                    <small>用于工作流引用。通常不需要修改。</small>
                </label>
                <label v-if="canChangeType" class="form-field">
                    <span>对象类型</span>
                    <select v-model="typeModel" class="product-input">
                        <option v-for="item in ANNOTATION_TYPES" :key="item.value" :value="item.value">
                            {{ item.label }}
                        </option>
                    </select>
                </label>
            </div>
        </details>

        <div v-if="canDelete || canIgnore" class="object-inspector-danger">
            <button v-if="canIgnore" type="button" @click="emit('ignore')">忽略此对象</button>
            <button v-if="canDelete" type="button" class="danger" @click="emit('delete')">删除标注</button>
        </div>
    </div>
</template>

<style scoped>
.object-inspector {
    display: flex;
    flex-direction: column;
    gap: 18px;
    color: #0f172a;
}
.object-inspector-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
}
.object-inspector-heading > div { min-width: 0; }
.object-inspector-heading span {
    display: block;
    margin-bottom: 3px;
    color: #64748b;
    font-size: 11px;
    font-weight: 700;
}
.object-inspector-heading strong {
    display: block;
    overflow: hidden;
    font-size: 16px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.location-action {
    flex: 0 0 auto;
    min-height: 32px;
    border: 1px solid #dbe3ee;
    border-radius: 9px;
    padding: 0 10px;
    background: #fff;
    color: #334155;
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;
}
.location-action:hover { background: #f8fafc; }
.form-field {
    display: grid;
    gap: 7px;
}
.form-field > span {
    color: #334155;
    font-size: 12px;
    font-weight: 700;
}
.form-field small {
    color: #94a3b8;
    font-size: 10px;
    line-height: 1.45;
}
.product-input {
    width: 100%;
    min-height: 40px;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    padding: 0 11px;
    outline: none;
    background: #fff;
    color: #0f172a;
    font: inherit;
    font-size: 12px;
    transition: border-color .15s ease, box-shadow .15s ease;
}
.product-input:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, .12);
}
.range-adjustment {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 12px;
    border-radius: 11px;
    background: #f8fafc;
    color: #64748b;
    font-size: 11px;
}
.range-adjustment > div { display: flex; gap: 5px; }
.range-adjustment button {
    min-height: 28px;
    border: 1px solid #dbe3ee;
    border-radius: 8px;
    padding: 0 8px;
    background: #fff;
    color: #334155;
    font-size: 10px;
    cursor: pointer;
}
.range-adjustment button:disabled { opacity: .4; cursor: default; }
.advanced-settings {
    overflow: hidden;
    border: 1px solid #e2e8f0;
    border-radius: 11px;
    background: #fff;
}
.advanced-settings summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    color: #475569;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    list-style: none;
}
.advanced-settings summary::-webkit-details-marker { display: none; }
.advanced-settings summary::after { content: '⌄'; color: #94a3b8; font-size: 14px; }
.advanced-settings[open] summary::after { transform: rotate(180deg); }
.advanced-settings summary small { margin-left: auto; color: #94a3b8; font-size: 10px; font-weight: 500; }
.advanced-settings-content {
    display: grid;
    gap: 14px;
    padding: 0 12px 12px;
}
.object-inspector-danger {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 4px;
}
.object-inspector-danger button {
    min-height: 32px;
    border: 1px solid #dbe3ee;
    border-radius: 9px;
    padding: 0 10px;
    background: #fff;
    color: #64748b;
    font-size: 11px;
    cursor: pointer;
}
.object-inspector-danger .danger { border-color: #fecdd3; color: #be123c; }
.object-inspector-danger button:hover { background: #f8fafc; }
.object-inspector-danger .danger:hover { background: #fff1f2; }
</style>
