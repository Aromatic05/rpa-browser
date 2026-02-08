/**
 * target 解析：统一兼容老的 a11yNodeId/a11yHint 参数。
 */

import type { A11yHint, Target } from '../types';
import type { StepResult } from '../types';
import type { ToolError } from '../../trace/types';

type TargetInput = {
    target?: Target;
    a11yNodeId?: string;
    a11yHint?: A11yHint;
    selector?: string;
};

export const normalizeTarget = (input: TargetInput): Target | undefined => {
    if (input.target) return input.target;
    if (input.a11yNodeId || input.a11yHint || input.selector) {
        return { a11yNodeId: input.a11yNodeId, a11yHint: input.a11yHint, selector: input.selector };
    }
    return undefined;
};

export const mapTraceError = (error: ToolError | undefined): StepResult['error'] => {
    if (!error) {
        return { code: 'ERR_INTERNAL', message: 'trace error' };
    }
    if (error.code === 'ERR_NOT_FOUND' || error.code === 'ERR_AMBIGUOUS' || error.code === 'ERR_TIMEOUT') {
        return { code: error.code, message: error.message, details: error.details };
    }
    return { code: 'ERR_INTERNAL', message: error.message || 'internal error', details: error.details };
};

type A11yLike = { role?: string; name?: string; text?: string };

const normalizeText = (value?: string) =>
    (value || '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

export const matchesA11yHint = (candidate: A11yLike, hint?: A11yHint) => {
    if (!hint) return true;
    const candidateRole = normalizeText(candidate.role);
    const hintRole = normalizeText(hint.role);
    if (hintRole && hintRole === 'combobox' && candidateRole === 'combobox') return true;
    if (hint.role && candidateRole !== hintRole) return false;
    if (hint.name) {
        const nodeName = normalizeText(candidate.name || candidate.text);
        if (!nodeName.includes(normalizeText(hint.name))) return false;
    }
    if (hint.text) {
        const text = normalizeText(candidate.text || candidate.name);
        if (!text.includes(normalizeText(hint.text))) return false;
    }
    return true;
};
