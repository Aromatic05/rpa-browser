<script setup lang="ts">
import {computed} from 'vue';
import type {AnnotationBox, AnnotationBoxKind} from '../layout/annotation_boxes.js';
import type {LabelPlacement} from '../layout/label_layout.js';
import type {CanvasAnnotationDraft, CanvasEntityDraft} from '../types.js';
import type {CheckResultByAnnotation, PickCandidate} from '../types.js';
import EditCard from '../canvas/EditCard.vue';
import type {RecommendedType} from '../recommend/recommend_types.js';
import {entityVisualId, paginationPageVisualId} from '../visual_ids.js';
import {annotationVisualState} from '../state/product_ui.js';

const props = defineProps<{
    boxes: AnnotationBox[];
    placements: Record<string, LabelPlacement>;
    selectedAnnotationId: string | null;
    canvasDraft: CanvasEntityDraft[] | null;
    candidate: PickCandidate | null;
    candidateIndex: number;
    candidateChainLength: number;
    showEditor?: boolean;
    checkResults: CheckResultByAnnotation[] | null;
    viewportWidth: number;
    viewportHeight: number;
}>();

const emit = defineEmits<{
    (e: 'select', annotationId: string): void;
    (e: 'move', annotationId: string, dx: number, dy: number): void;
    (e: 'updateAnnotation', entityId: string, annotationId: string, patch: Partial<CanvasAnnotationDraft>): void;
    (e: 'reselect', annotationId: string | null): void;
    (e: 'navigate', direction: 'outer' | 'inner'): void;
    (e: 'delete', annotationId: string): void;
    (e: 'ignore', annotationId: string): void;
    (e: 'chooseType', type: RecommendedType): void;
    (e: 'setPrimaryKey', entityId: string, columnId: string, selected: boolean): void;
    (e: 'close'): void;
}>();

type LabelVM = {
    annotationId: string;
    kind: AnnotationBoxKind;
    placement: LabelPlacement;
    labelName: string;
    businessKey: string;
    matchCount: number;
    selected: boolean;
    ignored: boolean;
    color: string;
    dashed: boolean;
    visualStatus: 'inferred' | 'confirmed' | 'error' | 'ignored';
    primaryKey: boolean;
};

const checkLookup = computed(() => new Map(
    (props.checkResults ?? []).map((item) => [item.canvasAnnotationId, item]),
));

const labels = computed((): LabelVM[] => {
    const out: LabelVM[] = [];
    for (const annotationBox of props.boxes) {
        const placement = props.placements[annotationBox.annotationId];
        if (!placement) {continue;}
        const visual = annotationVisualState(
            annotationBox,
            checkLookup.value.get(annotationBox.annotationId) ?? null,
        );
        const entity = props.canvasDraft?.find((item) => item.id === annotationBox.entityId);
        out.push({
            annotationId: annotationBox.annotationId,
            kind: annotationBox.kind,
            placement,
            labelName: annotationBox.labelName,
            businessKey: annotationBox.businessKey,
            matchCount: annotationBox.matchCount,
            selected: annotationBox.annotationId === props.selectedAnnotationId,
            ignored: annotationBox.disposition === 'ignored',
            color: visual.color,
            dashed: visual.dashed,
            visualStatus: visual.status,
            primaryKey: annotationBox.kind === 'column' &&
                entity?.primaryKey?.fieldKey === annotationBox.businessKey,
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
        if (props.selectedAnnotationId === entityVisualId(entity.id)) {
            return {id: props.selectedAnnotationId, type: 'field', name: entity.name, businessKey: entity.businessTag, target: entity.target, origin: entity.origin, disposition: 'active'};
        }
        const column = entity.columns.find((item) => item.id === props.selectedAnnotationId);
        if (column) {
            return {id: column.id, type: 'field', name: column.name, businessKey: column.fieldKey, target: {}, origin: column.origin, disposition: column.disposition};
        }
        for (const columnAction of entity.columns.flatMap((column) => column.actions)) {
            if (columnAction.id === props.selectedAnnotationId) {
                return {id: columnAction.id, type: 'action', name: columnAction.text, businessKey: columnAction.actionIntent, target: columnAction.target, origin: columnAction.origin, disposition: columnAction.disposition};
            }
        }
        if (props.selectedAnnotationId === paginationPageVisualId(entity.id) && entity.pagination) {
            return {id: props.selectedAnnotationId, type: 'pagination', name: entity.pagination.actionIntent, businessKey: entity.pagination.actionIntent, target: entity.pagination.pageTarget, origin: entity.origin, disposition: 'active'};
        }
    }
    return null;
});

const selectedEntity = computed((): CanvasEntityDraft | null => {
    if (!selectedBox.value) {return null;}
    if (!props.canvasDraft) {return null;}
    return props.canvasDraft.find((entity) => entity.id === selectedBox.value!.entityId) ?? null;
});

const selectedIsNativeAnnotation = computed((): boolean => {
    if (!props.selectedAnnotationId || !selectedEntity.value) {return false;}
    return selectedEntity.value.annotations.some((annotation) => annotation.id === props.selectedAnnotationId);
});

const selectedCanSetPrimaryKey = computed((): boolean =>
    selectedBox.value?.kind === 'column' && selectedEntity.value?.kind === 'table',
);

const selectedCanReselect = computed((): boolean =>
    selectedBox.value?.kind !== 'column',
);

const selectedIsPrimaryKey = computed((): boolean =>
    Boolean(
        selectedCanSetPrimaryKey.value &&
        selectedEntity.value?.primaryKey?.fieldKey === selectedBox.value?.businessKey,
    ),
);

const editCardPlacement = computed((): LabelPlacement | null => {
    if (!props.selectedAnnotationId) {return null;}
    return props.placements[props.selectedAnnotationId] ?? null;
});

const editCardStyle = computed((): Record<string, string> => {
    const placement = editCardPlacement.value;
    if (!placement) {return {display: 'none'};}
    const width = Math.min(320, Math.max(280, props.viewportWidth - 24));
    const desiredLeft = placement.box.x + placement.box.width / 2 - width / 2;
    const left = Math.max(12, Math.min(desiredLeft, props.viewportWidth - width - 12));
    const estimatedHeight =
        150 +
        (selectedIsNativeAnnotation.value ? 40 : 0) +
        (props.candidateChainLength > 1 ? 38 : 0) +
        (selectedCanSetPrimaryKey.value ? 58 : 0);
    const desiredTop = placement.box.y - 16;
    const top = Math.max(12, Math.min(
        desiredTop,
        Math.max(12, props.viewportHeight - estimatedHeight - 12),
    ));
    return {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
    };
});

const labelStyle = (label: LabelVM): Record<string, string> => ({
    left: `${label.placement.box.x}px`,
    top: `${label.placement.box.y}px`,
    width: `${label.placement.box.width}px`,
    height: `${label.placement.box.height}px`,
    '--annotation-color': label.color,
    borderStyle: label.dashed ? 'dashed' : 'solid',
});

const onSelect = (annotationId: string): void => {
    emit('select', annotationId);
};

let dragState: {annotationId: string; pointerId: number; x: number; y: number; moved: boolean} | null = null;

const onLabelPointerDown = (event: PointerEvent, annotationId: string): void => {
    if (event.button !== 0) {return;}
    dragState = {
        annotationId,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
};

const onLabelPointerMove = (event: PointerEvent): void => {
    const drag = dragState;
    if (!drag || drag.pointerId !== event.pointerId) {return;}
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (dx === 0 && dy === 0) {return;}
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = true;
    emit('move', drag.annotationId, dx, dy);
};

const onLabelPointerUp = (event: PointerEvent): void => {
    if (!dragState || dragState.pointerId !== event.pointerId) {return;}
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {target.releasePointerCapture(event.pointerId);}
    const shouldSelect = !dragState.moved;
    const annotationId = dragState.annotationId;
    dragState = null;
    if (shouldSelect) {onSelect(annotationId);}
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
            v-show="!(showEditor !== false && label.selected && selectedAnnotation)"
            :key="`label-${label.annotationId}`"
            type="button"
            class="annotator-label"
            :data-annotation-id="label.annotationId"
            :data-side="label.placement.side"
            :class="[
                `state-${label.visualStatus}`,
                {selected: label.selected, ignored: label.ignored},
            ]"
            :style="labelStyle(label)"
            @pointerdown.stop="onLabelPointerDown($event, label.annotationId)"
            @pointermove.stop="onLabelPointerMove"
            @pointerup.stop="onLabelPointerUp"
            @pointercancel.stop="onLabelPointerUp"
        >
            <span class="annotator-label-name">{{ label.labelName }}</span>
            <template v-if="label.businessKey !== label.labelName">
                <span class="annotator-label-divider">/</span>
                <span class="annotator-label-key">{{ label.businessKey }}</span>
            </template>
            <span v-if="label.primaryKey" class="annotator-primary-key-badge">主键</span>
            <span
                v-if="label.matchCount > 1"
                class="annotator-label-count"
            >x{{ label.matchCount }}</span>
        </button>
        <div
            v-if="showEditor !== false && editCardPlacement && selectedAnnotation"
            class="annotator-edit-anchor"
            :style="editCardStyle"
        >
            <EditCard
                :annotation="selectedAnnotation"
                :annotation-kind="selectedBox?.kind || null"
                :entity="selectedEntity"
                :candidate="candidate"
                :candidate-index="candidateIndex"
                :candidate-chain-length="candidateChainLength"
                :can-change-type="selectedIsNativeAnnotation"
                :can-delete="selectedBox?.kind !== 'entity'"
                :can-reselect="selectedCanReselect"
                :can-ignore="selectedBox?.kind !== 'entity' && selectedBox?.kind !== 'pagination'"
                :can-set-primary-key="selectedCanSetPrimaryKey"
                :is-primary-key="selectedIsPrimaryKey"
                @update="onUpdate"
                @reselect="onReselect"
                @outer="emit('navigate', 'outer')"
                @inner="emit('navigate', 'inner')"
                @delete="selectedAnnotation && emit('delete', selectedAnnotation.id)"
                @ignore="selectedAnnotation && emit('ignore', selectedAnnotation.id)"
                @choose-type="(t) => emit('chooseType', t)"
                @set-primary-key="(selected) => selectedBox && emit('setPrimaryKey', selectedBox.entityId, selectedBox.annotationId, selected)"
                @close="emit('close')"
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
    border: 1.5px solid var(--annotation-color, #64748b);
    border-radius: 8px;
    background: #ffffff;
    color: #0f172a;
    font-size: 12px;
    overflow: hidden;
    white-space: nowrap;
    cursor: grab;
    pointer-events: auto;
    touch-action: none;
    user-select: none;
    box-shadow: 0 4px 10px rgba(15, 23, 42, 0.12);
    text-align: left;
    overflow: hidden;
}
.annotator-label[data-side="top"],
.annotator-label[data-side="bottom"] {
    justify-content: center;
    box-shadow: 0 3px 9px rgba(15, 23, 42, 0.14);
}
.annotator-label.selected {
    border-color: #0f172a;
    border-style: solid !important;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.28);
}
.annotator-label.state-inferred { opacity: .78; }
.annotator-label.state-error {
    border-color: #dc2626;
    background: #fff7f7;
    color: #991b1b;
}
.annotator-label.ignored {
    opacity: 0.55;
    background: #f1f5f9;
}
.annotator-label-name {
    font-weight: 700;
}
.annotator-label-divider { color: #cbd5e1; }
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
.annotator-primary-key-badge {
    flex: 0 0 auto;
    border-radius: 999px;
    padding: 1px 6px;
    background: #fef3c7;
    color: #92400e;
    font-size: 9px;
    font-weight: 800;
}
.annotator-edit-anchor {
    position: absolute;
    pointer-events: auto;
    z-index: 3;
    border: 1px solid #cbd5e1;
    border-radius: 14px;
    padding: 12px;
    background: rgba(255, 255, 255, .98);
    box-shadow: 0 18px 48px rgba(15, 23, 42, .26);
    backdrop-filter: blur(16px);
    max-height: calc(100vh - 24px);
    overflow: auto;
}
</style>
