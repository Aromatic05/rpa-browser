<script setup lang="ts">
import {computed} from 'vue';
import type {EntityKind, PickCandidate, PickPurpose} from '../types.js';
import {candidateDisplayName} from '../state/product_ui.js';

const props = defineProps<{
    candidate: PickCandidate | null;
    candidateIndex: number;
    candidateChainLength: number;
    currentEntityKind: EntityKind | undefined;
    pointer: {x: number; y: number} | null;
    purpose: PickPurpose;
}>();

const emit = defineEmits<{
    (e: 'navigate', direction: 'outer' | 'inner'): void;
    (e: 'confirm'): void;
    (e: 'cancel'): void;
}>();

const canOuter = computed(() => props.candidateIndex < props.candidateChainLength - 1);
const canInner = computed(() => props.candidateIndex > 0);
const displayName = computed(() => candidateDisplayName(props.candidate, props.purpose));
const candidatePosition = computed(() => {
    if (props.candidateChainLength <= 0 || props.candidateIndex < 0) {return ''}
    return `${props.candidateIndex + 1} / ${props.candidateChainLength}`;
});
const objectType = computed(() => {
    if (props.purpose === 'entity') {return '业务区域';}
    switch (props.candidate?.level) {
        case 'field': return '字段';
        case 'control': return '操作';
        case 'row': return '数据行';
        case 'group':
        case 'region': return '区域';
        default: return '页面对象';
    }
});
</script>

<template>
    <section
        v-if="candidate"
        class="scope-confirmation annotator-pick-overlay"
        data-rpa-snapshot-ignore="true"
        data-rpa-annotator-host="true"
        aria-live="polite"
    >
        <div class="scope-confirmation-copy">
            <span class="scope-confirmation-kicker">
                {{ purpose === 'entity' ? '确认实体范围' : '确认页面对象' }}
            </span>
            <div class="scope-confirmation-title-row">
                <strong>{{ displayName }}</strong>
                <span>{{ objectType }}</span>
            </div>
            <p v-if="purpose === 'entity'">
                蓝色边框应完整覆盖查询条件、结果区域和翻页控件。
            </p>
            <p v-else>
                蓝色边框应只覆盖要标注的字段、按钮或表格对象。
            </p>
        </div>

        <div class="scope-confirmation-range" v-if="candidateChainLength > 1">
            <button
                type="button"
                :disabled="!canInner"
                aria-label="缩小选择范围"
                @click.stop="emit('navigate', 'inner')"
            >
                <span aria-hidden="true">−</span>
                缩小范围
            </button>
            <span>{{ candidatePosition }}</span>
            <button
                type="button"
                :disabled="!canOuter"
                aria-label="扩大选择范围"
                @click.stop="emit('navigate', 'outer')"
            >
                扩大范围
                <span aria-hidden="true">＋</span>
            </button>
        </div>

        <div class="scope-confirmation-actions">
            <button type="button" class="scope-cancel" @click.stop="emit('cancel')">取消</button>
            <button type="button" class="scope-confirm annotator-pick-confirm" @click.stop="emit('confirm')">
                {{ purpose === 'entity' ? '确认这个区域' : '确认这个对象' }}
            </button>
        </div>
    </section>
</template>

<style scoped>
.scope-confirmation {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%);
    width: min(680px, calc(100vw - 40px));
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 18px 24px;
    align-items: center;
    padding: 18px 20px;
    border: 1px solid rgba(148, 163, 184, .42);
    border-radius: 18px;
    background: rgba(255, 255, 255, .96);
    box-shadow: 0 24px 64px rgba(15, 23, 42, .24), 0 4px 16px rgba(15, 23, 42, .10);
    backdrop-filter: blur(18px);
    color: #0f172a;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: auto;
    z-index: 4;
}
.scope-confirmation-copy { min-width: 0; }
.scope-confirmation-kicker {
    display: block;
    margin-bottom: 5px;
    color: #2563eb;
    font-size: 11px;
    font-weight: 750;
    letter-spacing: .08em;
}
.scope-confirmation-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}
.scope-confirmation-title-row strong {
    overflow: hidden;
    color: #0f172a;
    font-size: 17px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.scope-confirmation-title-row span {
    flex: 0 0 auto;
    padding: 3px 8px;
    border-radius: 999px;
    background: #eff6ff;
    color: #1d4ed8;
    font-size: 11px;
    font-weight: 650;
}
.scope-confirmation-copy p {
    margin: 6px 0 0;
    color: #64748b;
    font-size: 12px;
    line-height: 1.5;
}
.scope-confirmation-range {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border-radius: 12px;
    background: #f8fafc;
}
.scope-confirmation-range > span {
    min-width: 48px;
    color: #64748b;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-align: center;
}
.scope-confirmation-range button {
    min-height: 34px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: #334155;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
}
.scope-confirmation-range button:hover:not(:disabled) { background: #e2e8f0; }
.scope-confirmation-range button:disabled { opacity: .35; cursor: default; }
.scope-confirmation-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}
.scope-confirmation-actions button {
    height: 40px;
    border-radius: 11px;
    padding: 0 16px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}
.scope-cancel { border: 1px solid #dbe3ee; background: #fff; color: #475569; }
.scope-confirm { border: 1px solid #2563eb; background: #2563eb; color: #fff; box-shadow: 0 8px 18px rgba(37, 99, 235, .24); }
.scope-cancel:hover { background: #f8fafc; }
.scope-confirm:hover { background: #1d4ed8; }
@media (max-width: 640px) {
    .scope-confirmation { grid-template-columns: 1fr; bottom: 14px; }
    .scope-confirmation-actions { justify-content: flex-end; }
}
</style>
