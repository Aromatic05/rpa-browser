<script setup lang="ts">
import type {CanvasEntityDraft} from '../types.js';
import type {
    BusinessObjectAddOption,
    BusinessObjectItem,
    EntityObjectSummary,
} from '../state/product_ui.js';

const props = defineProps<{
    entity: CanvasEntityDraft;
    items: BusinessObjectItem[];
    summary: EntityObjectSummary;
    addOptions: BusinessObjectAddOption[];
    selectedAnnotationId: string | null;
    busy: boolean;
}>();

const emit = defineEmits<{
    (e: 'select', annotationId: string): void;
    (e: 'reselect', annotationId: string): void;
    (e: 'add', type: BusinessObjectAddOption['type']): void;
    (e: 'close'): void;
}>();

const stateLabel = (item: BusinessObjectItem): string => {
    if (item.disposition === 'ignored') {return '不使用';}
    if (item.validation === 'missing' || item.validation === 'multiple' || item.validation === 'invalid') {return '需要处理';}
    if (item.validation === 'unique') {return '已定位';}
    return item.origin === 'inferred' ? '已识别' : '已调整';
};

const stateClass = (item: BusinessObjectItem): string => {
    if (item.disposition === 'ignored') {return 'ignored';}
    if (item.validation === 'missing' || item.validation === 'multiple' || item.validation === 'invalid') {
        return 'error';
    }
    if (item.validation === 'unique') {return 'valid';}
    return item.origin === 'inferred' ? 'inferred' : 'confirmed';
};
</script>

<template>
    <section class="business-object-panel" data-rpa-snapshot-ignore="true">
        <header>
            <div>
                <small>识别结果</small>
                <strong>{{ entity.name || '当前区域' }}</strong>
            </div>
            <button type="button" aria-label="关闭识别结果" @click="emit('close')">×</button>
        </header>

        <div class="object-summary" aria-label="识别结果统计">
            <span v-if="summary.fields">查询条件 {{ summary.fields }}</span>
            <span v-if="summary.queryActions">列表操作 {{ summary.queryActions }}</span>
            <span v-if="summary.columns">表格列 {{ summary.columns }}</span>
            <span v-if="summary.rowActions">行操作 {{ summary.rowActions }}</span>
            <span v-if="summary.pagination">分页 {{ summary.pagination }}</span>
        </div>

        <div class="object-list">
            <article
                v-for="item in items"
                :key="item.annotationId"
                :data-business-object-id="item.annotationId"
                :data-business-object-role="item.role"
                :class="[
                    'object-item',
                    `state-${stateClass(item)}`,
                    {selected: item.annotationId === selectedAnnotationId},
                ]"
            >
                <button
                    type="button"
                    class="object-main"
                    :disabled="busy"
                    @click="emit('select', item.annotationId)"
                >
                    <span class="object-role">{{ item.roleLabel }}</span>
                    <span class="object-copy">
                        <strong>{{ item.name }}</strong>
                    </span>
                    <em>{{ stateLabel(item) }}</em>
                </button>
                <button
                    v-if="item.canReselect"
                    type="button"
                    class="object-reselect"
                    :disabled="busy"
                    @click="emit('reselect', item.annotationId)"
                >重选位置</button>
            </article>
        </div>

        <footer>
            <button
                v-for="option in addOptions"
                :key="option.type"
                type="button"
                :data-business-object-add="option.type"
                :disabled="busy"
                :title="option.description"
                @click="emit('add', option.type)"
            >
                <strong>{{ option.label }}</strong>
                <small>{{ option.description }}</small>
            </button>
        </footer>
    </section>
</template>

<style scoped>
.business-object-panel {
    position: fixed;
    right: 16px;
    bottom: 70px;
    z-index: 2147483646;
    width: min(400px, calc(100vw - 32px));
    max-height: min(440px, calc(100vh - 100px));
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    gap: 10px;
    padding: 14px;
    border: 1px solid rgba(100, 116, 139, .28);
    border-radius: 16px;
    background: rgba(255, 255, 255, .98);
    box-shadow: 0 20px 60px rgba(15, 23, 42, .28);
    color: #0f172a;
    pointer-events: auto;
    backdrop-filter: blur(18px);
}
.business-object-panel header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
}
.business-object-panel header > div { min-width: 0; }
.business-object-panel header small,
.business-object-panel header span {
    display: block;
    color: #64748b;
    font-size: 11px;
}
.business-object-panel header strong {
    display: block;
    overflow: hidden;
    margin: 2px 0;
    font-size: 15px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.business-object-panel header button {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
}
.business-object-panel header button:hover { background: #f1f5f9; }
.object-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
}
.object-summary span {
    padding: 4px 8px;
    border-radius: 999px;
    background: #f1f5f9;
    color: #475569;
    font-size: 10px;
    font-weight: 700;
}
.object-list {
    min-height: 80px;
    overflow: auto;
    display: grid;
    align-content: start;
    gap: 6px;
    padding-right: 2px;
}
.object-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px;
    border: 1px solid #e2e8f0;
    border-radius: 11px;
    padding: 4px;
    background: #fff;
}
.object-item.selected {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, .10);
}
.object-item.state-error { border-color: #fecaca; background: #fff7f7; }
.object-item.state-ignored { opacity: .58; }
.object-main {
    min-width: 0;
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr) auto;
    gap: 9px;
    align-items: center;
    border: 0;
    border-radius: 8px;
    padding: 7px 8px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
}
.object-main:hover:not(:disabled) { background: #f8fafc; }
.object-role {
    color: #475569;
    font-size: 10px;
    font-weight: 800;
}
.object-copy { min-width: 0; }
.object-copy strong,
.object-copy small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.object-copy strong { font-size: 12px; }
.object-main em {
    color: #64748b;
    font-size: 10px;
    font-style: normal;
    font-weight: 700;
}
.state-error .object-main em { color: #dc2626; }
.state-valid .object-main em { color: #15803d; }
.object-reselect {
    align-self: center;
    min-height: 30px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 0 9px;
    background: #fff;
    color: #334155;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
}
.object-reselect:hover:not(:disabled) { background: #f8fafc; }
.business-object-panel footer {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 7px;
    padding-top: 2px;
}
.business-object-panel footer button {
    min-height: 54px;
    border: 1px solid #bfdbfe;
    border-radius: 11px;
    padding: 8px 10px;
    background: #eff6ff;
    color: #1e3a8a;
    text-align: left;
    cursor: pointer;
}
.business-object-panel footer button:hover:not(:disabled) { background: #dbeafe; }
.business-object-panel footer strong,
.business-object-panel footer small { display: block; }
.business-object-panel footer strong { font-size: 11px; }
.business-object-panel footer small { margin-top: 3px; color: #475569; font-size: 9px; }
.business-object-panel button:disabled { opacity: .45; cursor: default; }
@media (max-width: 560px) {
    .object-main { grid-template-columns: 62px minmax(0, 1fr); }
    .object-main em { grid-column: 2; }
    .business-object-panel footer { grid-template-columns: 1fr; }
}
</style>
