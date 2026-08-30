import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {LibraryAssetKind} from '../../library/contracts';
import {queryKnowledgeCatalog} from './catalog';
import {KNOWLEDGE_CATALOG_LIMIT_MAX, type KnowledgeSeamDeps} from './contracts';
import {inspectKnowledgeAsset} from './inspect';

export const KNOWLEDGE_CATALOG_TOOL = 'agent.knowledge.catalog';
export const KNOWLEDGE_INSPECT_TOOL = 'agent.knowledge.inspect';

const catalogKindValues: Record<LibraryAssetKind, LibraryAssetKind> = {
    automation: 'automation',
    procedure: 'procedure',
    recovery: 'recovery',
    demonstration: 'demonstration',
    page_knowledge: 'page_knowledge',
};

const inspectKindValues: Record<LibraryAssetKind, LibraryAssetKind> = {
    ...catalogKindValues,
};

const toolResult = (details: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(details)}],
    details,
});

export const createKnowledgeTools = (deps: KnowledgeSeamDeps): readonly AgentTool[] => [
    {
        name: KNOWLEDGE_CATALOG_TOOL,
        label: KNOWLEDGE_CATALOG_TOOL,
        description: [
            'Read-only catalog of workspace knowledge assets this Agent may reference when authoring a Program.',
            'Returns only user-facing id/name/title/meaning, Procedure input/output signatures, Page Knowledge applicability/counts,',
            'health and capability summaries - never raw selectors, DOM refs, bodies, steps, checkpoints or revisions.',
            'Unhealthy and broken assets are labeled (health) and still listed, not silently dropped.',
            'Call it explicitly during planning; it is never executed automatically.',
        ].join(' '),
        parameters: Type.Object({
            kind: Type.Optional(Type.Enum(catalogKindValues)),
            filter: Type.Optional(Type.String()),
            limit: Type.Optional(Type.Integer({minimum: 1, maximum: KNOWLEDGE_CATALOG_LIMIT_MAX})),
        }, {additionalProperties: false}),
        execute: async (_toolCallId, params) => {
            const input = params as {kind?: LibraryAssetKind; filter?: string; limit?: number};
            const clean = {
                ...(input.kind !== undefined ? {kind: input.kind} : {}),
                ...(input.filter !== undefined ? {filter: input.filter} : {}),
                ...(input.limit !== undefined ? {limit: input.limit} : {}),
            };
            return toolResult(await queryKnowledgeCatalog(deps, clean));
        },
    },
    {
        name: KNOWLEDGE_INSPECT_TOOL,
        label: KNOWLEDGE_INSPECT_TOOL,
        description: [
            'Explicit read-only load of ONE knowledge asset to author against.',
            'Procedure returns its input/output signature and the nested assets it depends on by default; its DSL body is included ONLY when includeBody is set to true explicitly, and nested Checkpoint bodies are never auto-expanded.',
            'Page Knowledge returns a sanitized semantic entity schema (entityKey/kind, field keys and names, action intents, row actions, primary key, effect reversibility) with NO selectors, match rules or node ids.',
            'Recovery and Demonstration are catalog-only: Recovery applies automatically at runtime and Demonstration is replay-only; neither is loaded.',
            'Automation artifacts are persisted Programs and are not inspected here.',
            'This is a pure read that never executes, modifies or saves anything.',
        ].join(' '),
        parameters: Type.Object({
            kind: Type.Enum(inspectKindValues),
            name: Type.String({minLength: 1}),
            includeBody: Type.Optional(Type.Boolean()),
        }, {additionalProperties: false}),
        execute: async (_toolCallId, params) => {
            const input = params as {kind: LibraryAssetKind; name: string; includeBody?: boolean};
            return toolResult(await inspectKnowledgeAsset(deps, {
                kind: input.kind,
                name: input.name,
                ...(input.includeBody !== undefined ? {includeBody: input.includeBody} : {}),
            }));
        },
    },
];