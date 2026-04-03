import crypto from 'node:crypto';
import type { Page } from 'playwright';
import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import { mapTraceError } from '../../helpers/target';
import { collectRawData } from './collect';
import { fuseDomAndA11y } from './fusion';
import { buildSnapshot } from './build_snapshot';
import type { SnapshotResult } from './types';

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
            unified_graph: snapshot.root,
        },
    };
};

export const generateSemanticSnapshot = async (page: Page): Promise<SnapshotResult> => {
    // 第一阶段最小实现：只做 collect -> fuse -> buildSnapshot。
    // 不做 region/lca/compress/stable-id 等复杂语义处理。

    // 1) 采集原始观察：DOM、A11y。
    const raw = await collectRawData(page);

    // 2) DOM + A11y 融合为统一节点图。
    const graph = fuseDomAndA11y(raw.domTree, raw.a11yTree);

    // 3) 输出可调试 unified graph。
    return buildSnapshot(graph.root);
};
