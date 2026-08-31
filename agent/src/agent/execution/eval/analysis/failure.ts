import type {AgentEvalRun} from '../contracts';
import type {AgentEvalFailureCategory} from './contracts';
import {AGENT_EVAL_FAILURE_CATEGORIES} from './contracts';
import type {AgentProgramEffectSummary} from '../../types';

/**
 * Deterministic failure taxonomy over terminal / program / tool evidence only.
 * React-baseline journal facts are never inferred: classification never reads
 * a journal that the mode does not expose.
 */

const RESOLVE_TOOLS: ReadonlySet<string> = new Set([
    'debug.refresh',
    'debug.rebind',
    'browser.query',
    'browser.snapshot',
]);

const journalOf = (run: AgentEvalRun): readonly AgentProgramEffectSummary[] | null => {
    const programs = run.result.programs;
    if (!programs?.every((program) => program.effects !== undefined)) {
        return null;
    }
    return programs.flatMap((program) => program.effects ?? []);
};

const effectIssued = (run: AgentEvalRun): boolean => {
    if (run.metrics.effectCalls > 0) {
        return true;
    }
    if (run.result.trace.tools.some((tool) => tool.classification === 'effect')) {
        return true;
    }
    const journal = journalOf(run);
    return (journal?.length ?? 0) > 0;
};

const effectFailed = (run: AgentEvalRun): boolean => {
    if (run.result.trace.tools.some((tool) => tool.isError === true && tool.classification === 'effect')) {
        return true;
    }
    const journal = journalOf(run);
    return journal?.some((effect) => effect.status === 'failed') === true;
};

const recoveryAttempted = (run: AgentEvalRun): boolean => {
    if (run.metrics.postErrorEffectCalls > 0) {
        return true;
    }
    if (run.result.trace.tools.some(
        (tool) => tool.toolName === 'debug.rollback' || tool.toolName === 'debug.compensate',
    )) {
        return true;
    }
    const journal = journalOf(run);
    return journal?.some((effect) => effect.compensates !== undefined) === true;
};

const readResolveFailed = (run: AgentEvalRun): boolean =>
    run.result.trace.tools.some(
        (tool) => tool.isError === true
            && (tool.classification === 'read' || RESOLVE_TOOLS.has(tool.toolName)),
    );

/**
 * Single deterministic label for a failed run, or null for a successful run.
 * Priority: governance stop, planning (no mutation ever issued), recovery
 * (mutation failed after an attempt to recover), mutation (mutation failed
 * with no recovery attempt), read/resolve (resolution layer failed), then
 * verification (finished cleanly but the external verifier rejected it).
 */
export const classifyRunFailure = (run: AgentEvalRun): AgentEvalFailureCategory | null => {
    if (run.success) {
        return null;
    }
    const program = run.result.programs?.[0];
    if (program?.status === 'aborted') {
        return 'governance';
    }
    if (program?.status === 'invalid') {
        return 'planning';
    }
    if (!effectIssued(run)) {
        return 'planning';
    }
    if (effectFailed(run)) {
        return recoveryAttempted(run) ? 'recovery' : 'mutation';
    }
    if (readResolveFailed(run)) {
        return 'read-resolve';
    }
    if (!run.verification.passed) {
        return 'verification';
    }
    return 'unknown';
};

export const countFailureTaxonomy = (
    runs: readonly AgentEvalRun[],
): Readonly<Record<AgentEvalFailureCategory, number>> => {
    const counts = Object.fromEntries(
        AGENT_EVAL_FAILURE_CATEGORIES.map((category) => [category, 0]),
    ) as Record<AgentEvalFailureCategory, number>;
    for (const run of runs) {
        const category = classifyRunFailure(run);
        if (category !== null) {
            counts[category] += 1;
        }
    }
    return Object.freeze(counts);
};