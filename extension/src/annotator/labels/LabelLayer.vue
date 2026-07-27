<script setup lang="ts">
import {computed} from 'vue';
import type {AnnotationBox} from '../layout/annotation_boxes.js';
import type {LabelPlacement} from '../layout/label_layout.js';
import type {CanvasAnnotationDraft, CanvasEntityDraft} from '../types.js';
import type {PickCandidate} from '../types.js';
import EditCard from '../canvas/EditCard.vue';
import type {RecommendedType} from '../recommend/recommend_types.js';

const props = defineProps<{
    boxes: AnnotationBox[];
    placements: Record<string, LabelPlacement>;
    selectedAnnotationId: string | null;
    canvasDraft: CanvasEntityDraft[] | null;
    candidate: PickCandidate | null;
    candidateIndex: number;
    candidateChainLength: number;
}>();

const emit = defineEmits<{
    (e: 'select', annotationId: string): void;
    (e: 'updateAnnotation', entityId: string, annotationId: string, patch: Partial<CanvasAnnotationDraft>): void;
    (e: 'reselect', annotationId: string | null): void;
    (e: 'navigate', direction: 'outer' | 'inner'): void;
    (e: 'delete', annotationId: string): void;
    (e: 'ignore', annotationId: string): void;
    (e: 'chooseType', type: RecommendedType): void;
}>();

type LabelVM = {
    annotationId: string;
    placement: LabelPlacement;
    labelName: string;
    businessKey: string;
    matchCount: number;
    selected: boolean;
    ignored: boolean;
};

const labels = computed((): LabelVM[] => {
    const out: LabelVM[] = [];
    for (const annotationBox of props.boxes) {
        const placement = props.placements[annotationBox.annotationId];
        if (!placement) {continue;}
        out.push({
            annotationId: annotationBox.annotationId,
            placement,
            labelName: annotationBox.labelName,
            businessKey: annotationBox.businessKey,
            matchCount: annotationBox.matchCount,
            selected: annotationBox.annotationId === props.selectedAnnotationId,
            ignored: annotationBox.disposition === 'ignored',
        });
    }
    return out;
});

const selectedBox = computed((): AnnotationBox | null => {
    if (!props.selectedAnnotationId) {return null;}
    return props.boxes.find((box) => box.annotationId === props.selectedAnnotationId) ?? null;
});

const selectedAnnotation = computed((): CanvasAnnotationDraft | null => {
    if (!props.selectedAnnotationId || !props.canvasDraft) {return null;}
    for (const entity of props.canvasDraft) {
        const annotation = entity.annotations.find((a) => a.id === props.selectedAnnotationId);
        if (annotation) {return annotation;}
    }
    return null;
});

const selectedEntity = computed((): CanvasEntityDraft | null => {
    if (!selectedBox.value) {return null;}
    if (!props.canvasDraft) {return null;}
    return props.canvasDraft.find((entity) => entity.id === selectedBox.value!.entityId) ?? null;
});

const editCardPlacement = computed((): LabelPlacement | null => {
    if (!props.selectedAnnotationId) {return null;}
    return props.placements[props.selectedAnnotationId] ?? null;
});

const editCardStyle = computed((): Record<string, string> => {
    const placement = editCardPlacement.value;
    if (!placement) {return {display: 'none'};}
    return {
        left: `${placement.box.x}px`,
        top: `${placement.box.y + placement.box.height + 6}px`,
    };
});

const labelStyle = (placement: LabelPlacement): Record<string, string> => ({
    left: `${placement.box.x}px`,
    top: `${placement.box.y}px`,
    width: `${placement.box.width}px`,
    height: `${placement.box.height}px`,
});

const onSelect = (annotationId: string): void => {
    emit('select', annotationId);
};

const onUpdate = (patch: Partial<CanvasAnnotationDraft>): void => {
    if (!selectedBox.value || !selectedAnnotation.value) {return;}
    emit('updateAnnotation', selectedBox.value.entityId, selectedAnnotation.value.id, patch);
};

const onReselect = (): void => {
    emit('reselect', props.selectedAnnotationId);
};
</script>

<template>
    <div class="annotator-label-layer" data-rpa-snapshot-ignore="true">
        <button
            v-for="label in labels"
            :key="`label-${label.annotationId}`"
            type="button"
            class="annotator-label"
            :class="{selected: label.selected, ignored: label.ignored}"
            :style="labelStyle(label.placement)"
            @click.stop="onSelect(label.annotationId)"
            @pointerdown.stop="onSelect(label.annotationId)"
        >
            <span class="annotator-label-name">{{ label.labelName }}</span>
            <span class="annotator-label-key">{{ label.businessKey }}</span>
            <span
                v-if="label.matchCount > 1"
                class="annotator-label-count"
            >x{{ label.matchCount }}</span>
        </button>
        <div
            v-if="editCardPlacement && selectedAnnotation"
            class="annotator-edit-anchor"
            :style="editCardStyle"
        >
            <EditCard
                :annotation="selectedAnnotation"
                :entity="selectedEntity"
                :candidate="candidate"
                :candidate-index="candidateIndex"
                :candidate-chain-length="candidateChainLength"
                @update="onUpdate"
                @reselect="onReselect"
                @outer="emit('navigate', 'outer')"
                @inner="emit('navigate', 'inner')"
                @delete="selectedAnnotation && emit('delete', selectedAnnotation.id)"
                @ignore="selectedAnnotation && emit('ignore', selectedAnnotation.id)"
                @choose-type="(t) => emit('chooseType', t)"
            />
        </div>
    </div>
</template>

<style scoped>
.annotator-label-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2;
}
.annotator-label {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    background: #ffffff;
    color: #0f172a;
    font-size: 12px;
    cursor: pointer;
    pointer-events: auto;
    box-shadow: 0 4px 10px rgba(15, 23, 42, 0.12);
    text-align: left;
    overflow: hidden;
}
.annotator-label.selected {
    border-color: #0f172a;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.28);
}
.annotator-label.ignored {
    opacity: 0.55;
    background: #f1f5f9;
}
.annotator-label-name {
    font-weight: 700;
}
.annotator-label-key {
    color: #475569;
    font-size: 11px;
}
.annotator-label-count {
    margin-left: auto;
    background: #dbeafe;
    color: #1d4ed8;
    border-radius: 999px;
    padding: 1px 6px;
    font-size: 11px;
    font-weight: 700;
}
.annotator-edit-anchor {
    position: absolute;
    pointer-events: auto;
}
</style>
