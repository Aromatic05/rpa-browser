import crypto from 'node:crypto';
import type { Page } from 'playwright';
import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import { mapTraceError } from '../../helpers/target';
import { collectRawData } from './collect';
import { fuseDomAndA11y } from './fusion';
import { buildSpatialLayers, isNoiseLayer } from './spatial';
import { detectRegions } from './regions';
import { processRegion } from './process_region';
import { linkGlobalRelations } from './relations';
import { assignStableIds } from './stable_id';
import { buildSnapshot } from './build_snapshot';
import type { SnapshotResult, UnifiedNode } from './types';

export const executeBrowserSnapshot = async (
    step: Step<'browser.snapshot'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const info = await binding.traceTools['trace.page.getInfo']();
    if (!info.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(info.error) };
    }

    const includeA11y = step.args.includeA11y !== false;
    const focusOnly = step.args.focus_only === true;
    const traceSnapshot = await binding.traceTools['trace.page.snapshotA11y']({
        includeA11y,
        focusOnly,
    });
    if (!traceSnapshot.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(traceSnapshot.error) };
    }

    const snapshot = await generateSemanticSnapshot(binding.page);
    const snapshotId = traceSnapshot.data?.snapshotId || crypto.randomUUID();

    return {
        stepId: step.id,
        ok: true,
        data: {
            snapshot_id: snapshotId,
            url: info.data?.url,
            title: info.data?.title,
            a11y: includeA11y ? traceSnapshot.data?.a11y || JSON.stringify(snapshot) : undefined,
        },
    };
};

export const generateSemanticSnapshot = async (page: Page): Promise<SnapshotResult> => {
    // 1) 采集原始观察：DOM、A11y 等基础数据。
    const raw = await collectRawData(page);

    // 2) DOM + A11y 融合为统一节点图。
    const graph = fuseDomAndA11y(raw.domTree, raw.a11yTree);

    // 3) 对顶层子树做空间重排。
    const layeredGraph = buildSpatialLayers(graph);

    // 4) 创建虚拟根，先挂主内容。
    const root = createVirtualRoot();
    const [mainBody, ...overlays] = layeredGraph.root.children;
    if (mainBody) {
        root.children.push(mainBody);
    } else {
        root.children.push(layeredGraph.root);
    }

    // 5) 过滤明显噪声后挂 overlay。
    for (const overlay of overlays) {
        if (isNoiseLayer(overlay)) continue;
        root.children.push(overlay);
    }

    // 6) 每层做区域处理与语义处理。
    for (const layer of root.children) {
        const regions = detectRegions(layer);
        for (const region of regions) {
            const processed = processRegion(region);
            if (!processed) continue;
            replaceRegion(layer, region, processed);
        }
    }

    // 7) 处理跨层/跨区域关系。
    linkGlobalRelations(root);

    // 8) 压缩后生成稳定 ID。
    assignStableIds(root);

    // 9) 输出 snapshot。
    return buildSnapshot(root);
};

const createVirtualRoot = (): UnifiedNode => ({
    id: 'virtual-root',
    role: 'root',
    children: [],
});

const replaceRegion = (layer: UnifiedNode, target: UnifiedNode, next: UnifiedNode) => {
    const index = layer.children.findIndex((child) => child === target || child.id === target.id);
    if (index >= 0) {
        layer.children[index] = next;
        return;
    }
    for (const child of layer.children) {
        replaceRegion(child, target, next);
    }
};
