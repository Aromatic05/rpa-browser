import crypto from 'node:crypto';
import { getNodeBbox, getNodeContent, getNodeSemanticHints, normalizeText } from './runtime_store';
import type { Entity, EntityIndex, EntityKind, UnifiedNode } from './types';

export type EntityBuildResult = {
    entityIndex: EntityIndex;
    nodeEntityIndex: Record<string, string>;
};

export const buildEntityIndex = (root: UnifiedNode): EntityBuildResult => {
    const entityIndex: EntityIndex = {};
    const nodeEntityIndex: Record<string, string> = {};

    walk(root, (node) => {
        const kind = detectEntityKind(node);
        if (!kind) return;

        const name = normalizeText(node.name || getNodeContent(node));
        const id = makeEntityId(kind, node.id, name);
        const bbox = getNodeBbox(node);

        const entity: Entity = {
            id,
            kind,
            nodeId: node.id,
            name: name || undefined,
            bbox,
        };

        const childNodeIds = collectEntityChildNodeIds(node);
        if (childNodeIds.length > 0) {
            entity.childNodeIds = childNodeIds;
        }

        entityIndex[id] = entity;
        nodeEntityIndex[node.id] = id;
    });

    return { entityIndex, nodeEntityIndex };
};

const collectEntityChildNodeIds = (node: UnifiedNode): string[] => {
    const childNodeIds: string[] = [];
    walk(node, (candidate) => {
        if (candidate.id === node.id) return;
        if (childNodeIds.length >= 24) return;
        const role = normalizeRole(candidate.role);
        if (ACTION_OR_FIELD_ROLES.has(role)) {
            childNodeIds.push(candidate.id);
        }
    });
    return childNodeIds;
};

const detectEntityKind = (node: UnifiedNode): EntityKind | undefined => {
    const role = normalizeRole(node.role);
    if (ENTITY_KIND_BY_ROLE[role]) return ENTITY_KIND_BY_ROLE[role];

    const semanticKind = normalizeRole(getNodeSemanticHints(node)?.entityKind);
    if (semanticKind && ENTITY_KIND_SET.has(semanticKind as EntityKind)) {
        return semanticKind as EntityKind;
    }

    return undefined;
};

const makeEntityId = (kind: EntityKind, nodeId: string, name: string | undefined): string => {
    const seed = `${kind}|${nodeId}|${name || ''}`;
    const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 10);
    return `ent_${kind}_${hash}`;
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();

const ENTITY_KIND_BY_ROLE: Record<string, EntityKind | undefined> = {
    form: 'form',
    table: 'table',
    dialog: 'dialog',
    alertdialog: 'dialog',
    list: 'list',
    section: 'panel',
    article: 'panel',
    toolbar: 'toolbar',
};

const ENTITY_KIND_SET = new Set<EntityKind>(['form', 'table', 'dialog', 'list', 'panel', 'toolbar']);
const ACTION_OR_FIELD_ROLES = new Set([
    'button',
    'link',
    'input',
    'textarea',
    'select',
    'textbox',
    'combobox',
    'checkbox',
    'radio',
]);
