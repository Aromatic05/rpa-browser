import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError, normalizeTarget } from '../helpers/target';
import { resolveTargetNodeId } from '../helpers/resolve_target';

export const executeBrowserTakeScreenshot = async (
    step: Step<'browser.take_screenshot'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const target = normalizeTarget(step.args);
    let resolvedTarget:
        | {
              a11yNodeId?: string;
              selector?: string;
              role?: string;
              name?: string;
          }
        | undefined;
    if (target) {
        const resolved = await resolveTargetNodeId(binding, target);
        if (!resolved.ok) return { stepId: step.id, ok: false, error: resolved.error };
        resolvedTarget = resolved.target;
    }
    const shot = await binding.traceTools['trace.page.screenshot']({
        fullPage: step.args.full_page,
        a11yNodeId: resolvedTarget?.a11yNodeId,
        selector: resolvedTarget?.selector,
        role: resolvedTarget?.role,
        name: resolvedTarget?.name,
    });
    if (!shot.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(shot.error) };
    }
    if (typeof shot.data !== 'string' || shot.data.length === 0) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_BAD_RESPONSE', message: 'screenshot payload is empty' },
        };
    }
    if (step.args.inline === true) {
        return {
            stepId: step.id,
            ok: true,
            data: { mime: 'image/png', base64: shot.data },
        };
    }

    const buffer = Buffer.from(shot.data, 'base64');
    const dir = path.resolve(process.cwd(), '.artifacts/mcp/screenshots');
    await fs.mkdir(dir, { recursive: true });
    const fileName = `shot-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, buffer);

    return {
        stepId: step.id,
        ok: true,
        data: {
            mime: 'image/png',
            path: filePath,
            bytes: buffer.length,
            sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        },
    };
};
