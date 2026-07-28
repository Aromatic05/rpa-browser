import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps_types';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { resolveAtomicActionTarget } from '../../../snapshot';

export const executeBrowserTakeScreenshot = async (
    step: Step<'browser.take_screenshot'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const target = {
        nodeId: step.args.nodeId ?? step.resolve?.hint?.target?.nodeId,
        selector: step.args.selector ?? step.resolve?.hint?.locator?.direct?.query,
    };
    let buffer: Buffer;
    let targetData: Record<string, unknown> | undefined;
    try {
        if (target.nodeId || target.selector) {
            const resolved = await resolveAtomicActionTarget(binding.page, target);
            if (!resolved.ok) {
                return { stepId: step.id, ok: false, error: {
                    code: resolved.error.code,
                    message: resolved.error.message,
                    details: resolved.error.details,
                } };
            }
            buffer = await resolved.target.locator.screenshot({ type: 'png' });
            targetData = {
                nodeId: resolved.target.nodeId,
                controlRef: resolved.target.control?.ref,
                captureRevision: resolved.target.snapshot.observation.identity.captureRevision,
                resolver: 'snapshot-v2-canonical-locator',
            };
        } else {
            buffer = await binding.page.screenshot({
                type: 'png',
                fullPage: step.args.full_page === true,
            });
        }
    } catch (error) {
        return { stepId: step.id, ok: false, error: {
            code: /timeout/i.test(String(error)) ? 'ERR_TIMEOUT' : 'ERR_INTERNAL',
            message: error instanceof Error ? error.message : String(error),
        } };
    }
    if (buffer.length === 0) {
        return { stepId: step.id, ok: false, error: { code: 'ERR_BAD_RESPONSE', message: 'screenshot payload is empty' } };
    }
    if (step.args.inline === true) {
        return {
            stepId: step.id,
            ok: true,
            data: { mime: 'image/png', base64: buffer.toString('base64'), ...targetData },
        };
    }

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
            ...targetData,
        },
    };
};
