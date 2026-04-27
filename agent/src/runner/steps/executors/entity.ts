import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { ensureFreshEntityContext } from './entity_context';
import { filterEntityDiagnostics, summarizeEntityRuleDiagnostics } from './snapshot/core/diagnostics';
import { filterFinalEntities } from './snapshot/core/entity_query';
import { normalizeText } from './snapshot/core/runtime_store';
import { updateSnapshotOverlays } from './snapshot/core/session_store';
import { buildNodeSummary, buildTableMeta, toEntityOutputRecord } from './snapshot/core/entity_output';
import { buildFinalEntityViewFromSnapshot } from './snapshot/core/overlay';

export const executeBrowserEntity = async (
    step: Step<'browser.entity'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const context = await ensureFreshEntityContext(deps, workspaceId, `browser.entity.${step.args.op}`);
    const args = step.args;

    if (args.op === 'list' || args.op === 'find') {
        const filtered = filterFinalEntities(context.finalEntityView.entities, {
            kind: args.kind,
            businessTag: args.businessTag,
            query: args.query,
        });
        const diagnostics = summarizeEntityRuleDiagnostics(context.finalEntityView.diagnostics || []);

        return {
            stepId: step.id,
            ok: true,
            data: {
                total: filtered.length,
                entities: filtered.map((entity) => toEntityOutputRecord(entity)),
                diagnostics,
            },
        };
    }

    if (args.op === 'get') {
        const nodeId = normalizeText(args.nodeId);
        if (!nodeId) {
            return badArgs(step.id, 'nodeId is required');
        }

        const node = buildNodeSummary(context.snapshot, nodeId);
        if (!node) {
            return notFound(step.id, 'node id not found in snapshot', { nodeId });
        }

        const entities = context.finalEntityView.byNodeId[nodeId] || [];
        return {
            stepId: step.id,
            ok: true,
            data: {
                node,
                entities: entities.map((entity) => toEntityOutputRecord(entity)),
                total: entities.length,
                table_meta: buildTableMeta(context.snapshot, nodeId) || undefined,
                diagnostics: entities.flatMap((entity) => filterEntityDiagnostics(entity, context.finalEntityView.diagnostics || [])),
            },
        };
    }

    if (args.op === 'add') {
        const nodeId = normalizeText(args.nodeId);
        if (!nodeId) {
            return badArgs(step.id, 'nodeId is required');
        }

        if (!context.snapshot.nodeIndex[nodeId]) {
            return notFound(step.id, 'node id not found in snapshot', { nodeId });
        }

        const name = normalizeText(args.name);
        const businessTag = normalizeText(args.businessTag);
        const entry = updateSnapshotOverlays(context.binding, 'browser.entity.add', (overlays) => {
            overlays.addedEntities.push({
                nodeId,
                kind: args.kind,
                name,
                businessTag,
            });
        });

        const node = entry.finalSnapshot ? buildNodeSummary(entry.finalSnapshot, nodeId) : null;
        const finalView =
            entry.finalEntityView ||
            (entry.finalSnapshot ? buildFinalEntityViewFromSnapshot(entry.finalSnapshot, entry.overlays, true) : null);
        const added = [...(finalView?.byNodeId[nodeId] || [])]
            .reverse()
            .find(
                (entity) =>
                    entity.source === 'overlay_add' &&
                    entity.kind === args.kind &&
                    (name ? entity.name === name : true) &&
                    (businessTag ? entity.businessTag === businessTag : true),
            );

        return {
            stepId: step.id,
            ok: true,
            data: {
                node,
                entity: added ? toEntityOutputRecord(added) : undefined,
                overlay_summary: buildOverlaySummary(entry),
            },
        };
    }

    if (args.op === 'delete') {
        const nodeId = normalizeText(args.nodeId);
        if (!nodeId) {
            return badArgs(step.id, 'nodeId is required');
        }

        const businessTag = normalizeText(args.businessTag);
        const before = (context.finalEntityView.byNodeId[nodeId] || []).filter((entity) => {
            if (args.kind && entity.kind !== args.kind) {return false;}
            if (businessTag && entity.businessTag !== businessTag) {return false;}
            return true;
        }).length;

        const entry = updateSnapshotOverlays(context.binding, 'browser.entity.delete', (overlays) => {
            overlays.deletedEntities.push({
                nodeId,
                kind: args.kind,
                businessTag,
            });
        });

        const finalView =
            entry.finalEntityView ||
            (entry.finalSnapshot ? buildFinalEntityViewFromSnapshot(entry.finalSnapshot, entry.overlays, true) : null);
        const after = (finalView?.byNodeId[nodeId] || []).filter((entity) => {
            if (args.kind && entity.kind !== args.kind) {return false;}
            if (businessTag && entity.businessTag !== businessTag) {return false;}
            return true;
        }).length;

        return {
            stepId: step.id,
            ok: true,
            data: {
                node_id: nodeId,
                matched_before: before,
                matched_after: after,
                deleted_count: Math.max(0, before - after),
                node_exists: Boolean(context.snapshot.nodeIndex[nodeId]),
                overlay_summary: buildOverlaySummary(entry),
            },
        };
    }

    if (args.op === 'rename') {
        const nodeId = normalizeText(args.nodeId);
        const name = normalizeText(args.name);
        if (!nodeId || !name) {
            return badArgs(step.id, 'nodeId and name are required');
        }

        if (!context.snapshot.nodeIndex[nodeId]) {
            return notFound(step.id, 'node id not found in snapshot', { nodeId });
        }

        const entry = updateSnapshotOverlays(context.binding, 'browser.entity.rename', (overlays) => {
            overlays.renamedNodes[nodeId] = name;
        });

        const node = entry.finalSnapshot ? buildNodeSummary(entry.finalSnapshot, nodeId) : null;
        return {
            stepId: step.id,
            ok: true,
            data: {
                node,
                name,
                overlay_summary: buildOverlaySummary(entry),
            },
        };
    }

    return badArgs(step.id, 'unsupported browser.entity op');
};

const buildOverlaySummary = (entry: { overlays: { renamedNodes: Record<string, string>; addedEntities: unknown[]; deletedEntities: unknown[] } }) => ({
    rename_count: Object.keys(entry.overlays.renamedNodes).length,
    add_count: entry.overlays.addedEntities.length,
    delete_count: entry.overlays.deletedEntities.length,
});

const badArgs = (stepId: string, message: string): StepResult => ({
    stepId,
    ok: false,
    error: {
        code: 'ERR_BAD_ARGS',
        message,
    },
});

const notFound = (stepId: string, message: string, details?: unknown): StepResult => ({
    stepId,
    ok: false,
    error: {
        code: 'ERR_NOT_FOUND',
        message,
        details,
    },
});
