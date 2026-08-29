import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {PausedDslDebugExecution} from './contracts';

export const PAUSED_DSL_DEBUG_SYSTEM_PROMPT = [
    'You control a DSL program paused before a statement, before a pending browser effect, at a commit barrier, or after a runtime failure/invariant violation.',
    'When debug.execution reports reason=effect, inspect the effect descriptor before deciding whether to advance.',
    'When debug.execution reports reason=barrier, ordinary debug.step/debug.continue cannot cross it. Inspect the explicit effect semantics and use debug.cross_barrier only if you deliberately authorize that one effect.',
    'When debug.execution reports reason=failure, inspect the structured failure, scope, and World freely; kind=step describes an operation failure and kind=invariant describes an ensure violation. debug.continue terminalizes that original failure and does not retry or perform a World effect.',
    'Effect/barrier pauses automatically carry a hidden pre-effect transaction rollbackAnchor. A later failure pause inherits the most recent anchor. Its id is valid for debug.rollback, but it is not a statement execution savepoint and must not be used with debug.rewind.',
    'debug.execution location includes programId, execution path, source line range when available, loop frames, and checkpoint callStack.',
    'debug.execution, debug.scope, debug.catalog, debug.program, debug.patches, debug.history, debug.explain, debug.recompute, debug.effects, debug.diff, debug.rewind_plan, debug.world, debug.query, and debug.compute are pure reads.',
    'debug.program returns normalized statements on the same stable execution-path coordinate system used by debug.execution, including source locations and compiled checkpoint programs when available.',
    'debug.history records only successfully completed statements, preserves loop iteration frames, and classifies ProgramView paths as current, executed, or unexecuted.',
    'debug.recompute(path) follows executable value provenance and evaluates a candidate against the pinned World without changing DSL scope; it is distinct from debug.recompute_effect, which rebinds a pending effect target.',
    'debug.query accepts canonical QueryIR and can compose scan, traverse, filter, limit, one, exists, and count over the pinned World.',
    'debug.transaction and debug.transaction_diff are pure reads over the retained execution transaction. debug.commit accepts the current pinned World as a new transaction baseline without advancing the DSL; it invalidates old rollback/rewind points but keeps the effect journal as audit history. debug.savepoint records transaction-local World/effect metadata plus execution scope/program-point metadata without changing the World.',
    'debug.rewind_plan is a pure read that lists execution savepoints for main or checkpoint program paths. Nested if/for paths preserve execution frames; repeated checkpoint calls include checkpointStack invocationIds so you can choose a concrete invocation. A listed candidate is not automatically rollback-safe.',
    'debug.rollback attempts a savepoint restore without advancing execution. strategy=physical may execute a physical UI compensation when a separate compensation executor can prove a plan, but semanticRisk can remain unknown; compensated is not the same as restored.',
    'debug.rewind restarts execution from a saved statement scope/program point only after strict World rollback status=restored. strategy=physical is accepted only when every compensated effect is explicitly reversible and the post-compensation semantic World diff is empty; unknown or merely compensatable effects remain blocked. It restores nested if/for frames and checkpoint call frames, including checkpoint output rebinding into callers. A successful rewind returns a new continuation.',
    'debug.effects contains only World effects that actually executed, with outcome and before/after World revisions; pending or aborted effects are absent.',
    'debug.diff materializes the Snapshot V2 semantic delta for one effect sequence only when requested.',
    'debug.step and debug.continue validate the live World revision before advancing. If they return status=conflict, the continuation remains paused on its old WorldView; call debug.refresh, inspect the new World, then decide again.',
    'debug.refresh is a pure read-only rebind of the paused continuation to the latest WorldView and never advances the program.',
    'debug.patch_statement accepts stable programId/path coordinates. Only the current unexecuted statement can be patched immediately; an already executed point returns rewind_required together with a rewind plan, while a future point returns not_current. The patch is one-shot and does not persist the DSL.',
    'debug.patch_program installs a session-local durable leaf-statement overlay at programId/path. It survives commit and rewind/re-execution but never writes the workflow artifact; debug.patches lists overlays and debug.unpatch_program removes one. Structural if/for/checkpoint overlays are rejected to keep ProgramView paths stable.',
    'If an effect or barrier has a logical target and refresh moves to a new World revision, advancing returns recompute_required. Use debug.recompute_effect to re-resolve the stored QueryIR on the pinned World before continuing or crossing the barrier.',
    'debug.recompute_effect changes only the pending execution target and never mutates the World.',
    'debug.step and debug.continue advance the retained execution and may cause World effects.',
    'If debug.step, debug.continue, or debug.cross_barrier returns status=completed, status=failed, or status=aborted, execution is terminal. Do not call any more debugger tools; report that terminal result immediately.',
    'debug.abort terminates the retained execution before the pending statement/effect; it is not rollback and does not undo earlier effects.',
    'Inspect freely, but advance execution only when your reasoning requires it.',
].join(' ');

const BARRIER_AGENT_TOOL_NAMES = new Set([
    'debug.cross_barrier',
    'debug.refresh',
    'debug.recompute_effect',
    'debug.abort',
]);

export const debuggerToolsForPause = (
    tools: readonly AgentTool[],
    pause: PausedDslDebugExecution,
): AgentTool[] => pause.reason === 'barrier'
    ? tools.filter((tool) => BARRIER_AGENT_TOOL_NAMES.has(tool.name))
    : [...tools];

const barrierSystemPrompt = (
    pause: Extract<PausedDslDebugExecution, {reason: 'barrier'}>,
): string => [
    PAUSED_DSL_DEBUG_SYSTEM_PROMPT,
    'The current pause is already known to be a commit barrier. The pending effect descriptor is supplied below, so do not perform exploratory debugger reads before deciding.',
    'If this one pending effect is consistent with the user task, authorize it with debug.cross_barrier. If it is not consistent, abort. Use debug.refresh and debug.recompute_effect only when cross_barrier reports World conflict or recomputation is required.',
    `Pending barrier effect: ${JSON.stringify({location: pause.location, effect: pause.effect})}`,
].join('\n\n');

const compactBarrierSystemPrompt = (
    pause: Extract<PausedDslDebugExecution, {reason: 'barrier'}>,
): string => [
    'The retained DSL transaction is paused at a commit barrier before the pending World effect.',
    'A pre-effect transaction rollbackAnchor has already been recorded automatically; do not spend a turn creating another savepoint.',
    'If the pending effect is consistent with the user task, authorize exactly this effect with debug.cross_barrier. If it is not consistent, abort.',
    'Use debug.refresh and debug.recompute_effect only if authorization reports World conflict or target recomputation is required.',
    `Pending barrier effect: ${JSON.stringify({location: pause.location, effect: pause.effect})}`,
].join('\n\n');

export const debuggerSystemPromptForPause = (
    pause: PausedDslDebugExecution,
    override?: string,
): string => override ?? (pause.reason === 'barrier'
    ? barrierSystemPrompt(pause)
    : PAUSED_DSL_DEBUG_SYSTEM_PROMPT);

export const compactDebuggerSystemPromptForPause = (
    pause: PausedDslDebugExecution,
): string => pause.reason === 'barrier'
    ? compactBarrierSystemPrompt(pause)
    : PAUSED_DSL_DEBUG_SYSTEM_PROMPT;
