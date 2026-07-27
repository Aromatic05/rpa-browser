<script setup lang="ts">
import {computed} from 'vue';
import type {
    CanvasAnnotationDraft,
    CanvasAnnotationType,
    CanvasEntityDraft,
} from '../types.js';
import type {PickCandidate} from '../types.js';
import {recommendAnnotationTypes, type RecommendedType} from '../recommend/recommend_types.js';

const props = defineProps<{
    annotation: CanvasAnnotationDraft | null;
    entity: CanvasEntityDraft | null;
    candidate: PickCandidate | null;
    candidateIndex: number;
    candidateChainLength: number;
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

const ANNOTATION_TYPES: CanvasAnnotationType[] = ['field', 'action', 'pagination'];

const recommendations = computed((): RecommendedType[] => {
    if (!props.candidate || !props.entity) {return [];}
    return recommendAnnotationTypes(props.candidate, props.entity.kind);
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
</script>

<template>
    <div class="annotator-edit-card" data-rpa-snapshot-ignore="true">
        <div class="annotator-edit-row">
            <label class="annotator-edit-label">名称</label>
            <input
                v-model="nameModel"
                class="annotator-edit-input"
                type="text"
                placeholder="标注名称"
            />
        </div>
        <div class="annotator-edit-row">
            <label class="annotator-edit-label">businessKey</label>
            <input
                v-model="businessKeyModel"
                class="annotator-edit-input"
                type="text"
                placeholder="business_key"
            />
        </div>
        <div class="annotator-edit-row">
            <label class="annotator-edit-label">类型</label>
            <select v-model="typeModel" class="annotator-edit-select">
                <option v-for="t in ANNOTATION_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
        </div>
        <div class="annotator-edit-recommend" v-if="recommendations.length > 0">
            <span class="annotator-edit-label">建议</span>
            <button
                v-for="rec in recommendations"
                :key="rec"
                type="button"
                class="annotator-edit-rec"
                @click="emit('chooseType', rec)"
            >{{ rec }}</button>
        </div>
        <div class="annotator-edit-actions">
            <button
                type="button"
                class="annotator-edit-btn"
                @click="emit('reselect')"
            >重新选择</button>
            <button
                type="button"
                class="annotator-edit-btn"
                :disabled="!canNavigateOuter"
                @click="emit('outer')"
            >选择外层</button>
            <button
                type="button"
                class="annotator-edit-btn"
                :disabled="!canNavigateInner"
                @click="emit('inner')"
            >选择内部</button>
            <button
                type="button"
                class="annotator-edit-btn annotator-edit-danger"
                @click="emit('delete')"
            >删除</button>
            <button
                type="button"
                class="annotator-edit-btn"
                @click="emit('ignore')"
            >忽略</button>
        </div>
    </div>
</template>

<style scoped>
.annotator-edit-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    box-shadow: 0 8px 22px rgba(15, 23, 42, 0.18);
    width: 240px;
    pointer-events: auto;
}
.annotator-edit-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.annotator-edit-label {
    font-size: 11px;
    color: #475569;
    font-weight: 700;
}
.annotator-edit-input, .annotator-edit-select {
    padding: 4px 6px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    font-size: 12px;
    background: #fff;
    color: #0f172a;
}
.annotator-edit-recommend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
}
.annotator-edit-rec {
    border: 1px solid #94a3b8;
    background: #f1f5f9;
    color: #0f172a;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
}
.annotator-edit-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
}
.annotator-edit-btn {
    border: 1px solid #cbd5e1;
    background: #fff;
    color: #0f172a;
    border-radius: 6px;
    padding: 4px 6px;
    font-size: 11px;
    cursor: pointer;
}
.annotator-edit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.annotator-edit-danger {
    border-color: #fecaca;
    background: #fef2f2;
    color: #b91c1c;
}
</style>
