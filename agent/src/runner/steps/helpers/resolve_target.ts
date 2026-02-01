/**
 * 统一 a11y 解析：基于 trace.a11y 找到唯一 nodeId。
 */

import type { PageBinding } from '../../../runtime/runtime_registry';
import type { A11yHint, Target } from '../types';
import type { StepResult } from '../types';
import { mapTraceError } from './target';

type ResolveResult = { ok: true; nodeId: string } | { ok: false; error: StepResult['error'] };

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
    if (target.selector) {
        return { ok: false, error: { code: 'ERR_INTERNAL', message: 'selector not supported' } };
    }
    if (target.a11yNodeId) {
        const resolved = await binding.traceTools['trace.a11y.resolveByNodeId']({
            a11yNodeId: target.a11yNodeId,
        });
        if (!resolved.ok) return { ok: false, error: mapTraceError(resolved.error) };
        return { ok: true, nodeId: target.a11yNodeId };
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
        return { ok: true, nodeId: candidates[0].nodeId };
    }
    return { ok: false, error: buildNotFound() };
};
