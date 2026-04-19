import type { NodeGraph, UnifiedNode } from '../core/types';
import { getNodeAttr, getNodeBbox, getNodeContent } from '../core/runtime_store';

export const buildSpatialLayers = (graph: NodeGraph): NodeGraph => {
    // 这里不是独立 Layer 类型系统，只对 NodeGraph 顶层子树做重排/抽取。
    const overlays: UnifiedNode[] = [];
    const mainCandidates: UnifiedNode[] = [];

    for (const child of graph.root.children) {
        if (isOverlayLikeNode(child)) {
            overlays.push(child);
            continue;
        }
        mainCandidates.push(child);
    }

    let mainBody: UnifiedNode | null = null;
    if (mainCandidates.length === 1) {
        [mainBody] = mainCandidates;
    } else if (mainCandidates.length > 1) {
        mainBody = {
            id: `${graph.root.id}-main-body`,
            role: 'main',
            children: mainCandidates,
        };
    } else if (overlays.length > 0) {
        mainBody = overlays.shift() || null;
    }

    const nextChildren: UnifiedNode[] = [];
    if (mainBody) {
        nextChildren.push(mainBody);
    }
    nextChildren.push(...overlays);

    return {
        root: {
            ...graph.root,
            children: nextChildren,
        },
    };
};

export const isNoiseLayer = (node: UnifiedNode): boolean => {
    // 第二阶段轻量版：小尺寸 + 靠边 + 无交互 才判噪声（保守策略）。
    const bbox = getNodeBbox(node);
    if (!bbox) return false;

    const hasSmallArea = bbox.width * bbox.height <= 16_000;
    const hasSmallSize = bbox.width <= 180 && bbox.height <= 180;
    const isNearEdge = bbox.x <= 24 || bbox.y <= 24;
    const noInteractiveSignal = !hasInteractiveSignal(node);

    return hasSmallArea && hasSmallSize && isNearEdge && noInteractiveSignal;
};

const isOverlayLikeNode = (node: UnifiedNode): boolean => {
    const role = node.role.toLowerCase();
    if (OVERLAY_ROLES.has(role)) return true;

    const position = getAttr(node, ['position']);
    if (position === 'fixed' || position === 'absolute') return true;

    const style = getAttr(node, ['style']);
    if (style.includes('position:fixed') || style.includes('position:absolute')) return true;

    const zIndex = readZIndex(node);
    if (zIndex >= 20) return true;

    if (getAttr(node, ['aria-modal']) === 'true') return true;

    return false;
};

const hasInteractiveSignal = (node: UnifiedNode): boolean => {
    if (INTERACTIVE_ROLES.has(node.role.toLowerCase())) return true;
    if (getNodeAttr(node, 'onclick') || getNodeAttr(node, 'href') || getNodeAttr(node, 'tabindex')) return true;
    if ((getNodeContent(node) || node.name || '').trim().length > 0) return true;
    return node.children.some((child) => hasInteractiveSignal(child));
};

const readZIndex = (node: UnifiedNode): number => {
    const raw = getAttr(node, ['zIndex', 'z-index']);
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return parsed;

    const style = getAttr(node, ['style']);
    const matched = style.match(/z-index\s*:\s*(-?\d+)/i);
    if (!matched) return Number.NEGATIVE_INFINITY;
    const styleParsed = Number.parseInt(matched[1] || '', 10);
    return Number.isNaN(styleParsed) ? Number.NEGATIVE_INFINITY : styleParsed;
};

const getAttr = (node: UnifiedNode, keys: string[]): string => {
    for (const key of keys) {
        const value = getNodeAttr(node, key);
        if (typeof value === 'string') {
            return value.trim().toLowerCase();
        }
    }
    return '';
};

const OVERLAY_ROLES = new Set(['dialog', 'menu', 'listbox', 'tooltip']);
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'input',
    'checkbox',
    'radio',
    'combobox',
    'option',
    'menuitem',
    'listbox',
    'dialog',
    'form',
]);
