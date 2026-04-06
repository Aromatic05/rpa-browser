/**
 * 统一目标解析：优先 id/selector，新协议失败时再回退旧 a11y 兼容路径。
 */

import type { PageBinding } from '../../../runtime/runtime_registry';
import type { A11yHint, Target } from '../types';
import type { StepResult } from '../types';
import type { SnapshotResult } from '../executors/snapshot/core/types';
import { mapTraceError } from './target';

export type ResolvedLocatorTarget = {
    selector?: string;
    role?: string;
    name?: string;
    a11yNodeId?: string;
};

type ResolveResult = { ok: true; target: ResolvedLocatorTarget } | { ok: false; error: StepResult['error'] };

const buildNotFound = (hint?: A11yHint): StepResult['error'] => ({
    code: 'ERR_NOT_FOUND',
    message: 'target not found',
    details: hint ? { hint } : undefined,
});

const buildAmbiguous = (hint: A11yHint, candidates: unknown[]): StepResult['error'] => ({
    code: 'ERR_AMBIGUOUS',
    message: 'target ambiguous',
    details: { hint, candidates },
});

export const resolveTargetNodeId = async (
    binding: PageBinding,
    target: Target | undefined,
): Promise<ResolveResult> => {
    if (!target) {
        return { ok: false, error: { code: 'ERR_INTERNAL', message: 'missing target' } };
    }

    if (target.id) {
        const resolved = resolveBySnapshotNodeId(binding, target.id);
        if (!resolved.ok) return resolved;
        return { ok: true, target: resolved.target };
    }

    if (target.selector) {
        return { ok: true, target: { selector: target.selector } };
    }

    // 旧协议兼容：a11yNodeId/a11yHint 仅在 step 层兜底，不再作为 MCP 主协议。
    if (target.a11yNodeId) {
        const resolved = await binding.traceTools['trace.a11y.resolveByNodeId']({
            a11yNodeId: target.a11yNodeId,
        });
        if (!resolved.ok) return { ok: false, error: mapTraceError(resolved.error) };
        return { ok: true, target: { a11yNodeId: target.a11yNodeId } };
    }
    if (target.a11yHint) {
        const found = await binding.traceTools['trace.a11y.findByA11yHint']({
            hint: target.a11yHint,
        });
        if (!found.ok) return { ok: false, error: mapTraceError(found.error) };
        const candidates = found.data || [];
        if (candidates.length === 0) {
            return { ok: false, error: buildNotFound(target.a11yHint) };
        }
        if (candidates.length > 1) {
            return { ok: false, error: buildAmbiguous(target.a11yHint, candidates) };
        }
        return { ok: true, target: { a11yNodeId: candidates[0].nodeId } };
    }
    return { ok: false, error: buildNotFound() };
};

const resolveBySnapshotNodeId = (
    binding: PageBinding,
    nodeId: string,
): { ok: true; target: ResolvedLocatorTarget } | { ok: false; error: StepResult['error'] } => {
    const cache = binding.traceCtx.cache as { latestSnapshot?: unknown };
    const snapshot = cache.latestSnapshot as SnapshotResult | undefined;
    if (!snapshot || !snapshot.locatorIndex) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'snapshot cache missing, call browser.snapshot before targeting by id',
                details: { id: nodeId },
            },
        };
    }

    const locator = snapshot.locatorIndex[nodeId];
    if (!locator) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'node id not found in snapshot locator index',
                details: { id: nodeId },
            },
        };
    }

    const direct = locator.direct;
    if (direct?.kind === 'css' && direct.query) {
        return { ok: true, target: { selector: direct.query } };
    }
    if (direct?.kind === 'role' && direct.query) {
        const parsed = parseRoleQuery(direct.query);
        if (parsed) return { ok: true, target: parsed };
    }
    if (direct?.fallback) {
        return { ok: true, target: { selector: direct.fallback } };
    }

    return {
        ok: false,
        error: {
            code: 'ERR_NOT_FOUND',
            message: 'node id has no executable direct locator',
            details: { id: nodeId, locator },
        },
    };
};

const parseRoleQuery = (query: string): ResolvedLocatorTarget | null => {
    const index = query.indexOf(':');
    if (index <= 0) return null;
    const role = query.slice(0, index).trim();
    const name = query.slice(index + 1).trim();
    if (!role) return null;
    return { role, name: name || undefined };
};
