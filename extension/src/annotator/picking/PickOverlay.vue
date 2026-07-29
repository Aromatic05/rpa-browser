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
const dockSide = computed<'top' | 'bottom'>(() => {
    const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight;
    return props.pointer && props.pointer.y > viewportHeight * 0.58 ? 'top' : 'bottom';
});
</script>

<template>
    <section
        v-if="candidate"
        :class="['scope-confirmation', 'annotator-pick-overlay', `dock-${dockSide}`]"
        data-rpa-snapshot-ignore="true"
        data-rpa-annotator-host="true"
        aria-live="polite"
    >
        <div class="scope-summary">
            <span class="scope-dot" aria-hidden="true"></span>
            <div>
                <small>{{ purpose === 'entity' ? '当前实体范围' : '当前页面对象' }}</small>
                <strong>{{ displayName }}</strong>
            </div>
            <em>{{ objectType }}<template v-if="candidatePosition"> · {{ candidatePosition }}</template></em>
        </div>

        <div class="scope-layer-actions" v-if="candidateChainLength > 1">
            <button
                type="button"
                :disabled="!canInner"
                aria-label="缩小选择范围"
                @click.stop="emit('navigate', 'inner')"
            >
                ↓ 选择内部
            </button>
            <button
                type="button"
                :disabled="!canOuter"
                aria-label="扩大选择范围"
                @click.stop="emit('navigate', 'outer')"
            >
                ↑ 选择外层
            </button>
        </div>

        <div class="scope-confirmation-actions">
            <button type="button" class="scope-cancel" @click.stop="emit('cancel')">退出</button>
            <button type="button" class="scope-confirm annotator-pick-confirm" @click.stop="emit('confirm')">
                {{ purpose === 'entity' ? '确认范围' : '确认对象' }}
            </button>
        </div>
    </section>
</template>

<style scoped>
.scope-confirmation {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    width: min(620px, calc(100vw - 24px));
    min-height: 58px;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 9px 10px 9px 12px;
    border: 1px solid rgba(100, 116, 139, .28);
    border-radius: 14px;
    background: rgba(255, 255, 255, .94);
    box-shadow: 0 14px 36px rgba(15, 23, 42, .20), 0 2px 8px rgba(15, 23, 42, .08);
    backdrop-filter: blur(14px) saturate(1.2);
    color: #0f172a;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: auto;
    z-index: 4;
}
.scope-confirmation.dock-top { top: 16px; }
.scope-confirmation.dock-bottom { bottom: 16px; }
.scope-summary {
    min-width: 0;
    flex: 1 1 220px;
    display: flex;
    align-items: center;
    gap: 9px;
}
.scope-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: #2563eb; box-shadow: 0 0 0 4px rgba(37, 99, 235, .12); }
.scope-summary > div { min-width: 0; }
.scope-summary small { display: block; color: #64748b; font-size: 9px; line-height: 1.2; }
.scope-summary strong {
    display: block;
    overflow: hidden;
    margin-top: 2px;
    font-size: 12px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.scope-summary em {
    flex: 0 0 auto;
    padding: 4px 7px;
    border-radius: 999px;
    background: #f1f5f9;
    color: #475569;
    font-size: 9px;
    font-style: normal;
    font-weight: 700;
}
.scope-layer-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    border-radius: 10px;
    background: #f1f5f9;
}
.scope-layer-actions button {
    height: 32px;
    border: 0;
    border-radius: 8px;
    padding: 0 10px;
    background: transparent;
    color: #334155;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
}
.scope-layer-actions button:hover:not(:disabled) { background: #fff; box-shadow: 0 1px 4px rgba(15, 23, 42, .10); }
.scope-layer-actions button:disabled { opacity: .3; cursor: default; }
.scope-confirmation-actions {
    display: flex;
    align-items: center;
    gap: 5px;
}
.scope-confirmation-actions button {
    height: 34px;
    border-radius: 9px;
    padding: 0 12px;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
}
.scope-cancel { border: 1px solid #dbe3ee; background: #fff; color: #475569; }
.scope-confirm { border: 1px solid #2563eb; background: #2563eb; color: #fff; box-shadow: 0 5px 12px rgba(37, 99, 235, .20); }
.scope-cancel:hover { background: #f8fafc; }
.scope-confirm:hover { background: #1d4ed8; }
@media (max-width: 720px) {
    .scope-confirmation { flex-wrap: wrap; }
    .scope-summary { flex-basis: calc(100% - 120px); }
    .scope-layer-actions { order: 3; flex: 1 1 100%; }
    .scope-layer-actions button { flex: 1; }
}
</style>
