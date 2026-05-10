import type { ControlCollector, ControlRegistry } from '../snapshot/control/types';
import type { BaseControlComponent } from '../snapshot/control/types';
import type { UnifiedNode } from '../snapshot/core/types';
import { getNodeAttr } from '../snapshot/core/runtime_store';
import { registerControlCollector } from '../snapshot/control/registry';

export const registerSelectOptionControls = (registry: ControlRegistry): void => {
    registerControlCollector(registry, collectNativeSelect);
    registerControlCollector(registry, collectRadioGroup);
    registerControlCollector(registry, collectCheckboxGroup);
    registerControlCollector(registry, collectCustomSelect);
};

const OWNER = 'browser.select_option';
const CAPABILITIES = ['select_option'];
const SOURCE = 'auto';

type OptionEntry = {
    value: string;
    label: string;
    selected: boolean;
    nodeId: string;
};

type ParentIdMap = Record<string, string | undefined>;

const collectNativeSelect: ControlCollector = (root, _nodeIndex) => {
    const components: BaseControlComponent[] = [];
    walk(root, (node) => {
        const tag = normalizeLower(getNodeAttr(node, 'tag'));
        if (tag !== 'select') {return;}

        const options = collectSelectOptions(node);
        components.push({
            id: node.id,
            kind: 'native_select',
            owner: OWNER,
            capabilities: CAPABILITIES,
            source: SOURCE,
            confidence: 1,
            rootNodeId: node.id,
            controlNodeId: node.id,
            triggerNodeId: node.id,
            popupNodeId: '',
            labelNodeId: '',
            valueNodeId: '',
            optionNodeIds: options.map((opt) => opt.nodeId),
            state: {
                expanded: false,
                multiple: normalizeLower(getNodeAttr(node, 'multiple')) === 'true',
                disabled: normalizeLower(getNodeAttr(node, 'disabled')) === 'true',
                readonly: normalizeLower(getNodeAttr(node, 'readonly')) === 'true',
                focused: normalizeLower(getNodeAttr(node, 'focused')) === 'true',
            },
            data: {
                options,
                selectedValues: options.filter((opt) => opt.selected).map((opt) => opt.value),
                selectedLabels: options.filter((opt) => opt.selected).map((opt) => opt.label),
                optionMatchHints: options.map((opt) => opt.label),
            },
        });
    });
    return components;
};

const collectSelectOptions = (selectNode: UnifiedNode): OptionEntry[] => {
    const options: OptionEntry[] = [];
    for (const child of selectNode.children) {
        const tag = normalizeLower(getNodeAttr(child, 'tag'));
        if (tag !== 'option') {continue;}
        const label = readNodeText(child);
        const value = normalizeLower(getNodeAttr(child, 'value')) || label;
        const selected = normalizeLower(getNodeAttr(child, 'selected')) === 'true';
        options.push({ value, label, selected, nodeId: child.id });
    }
    return options;
};

const collectRadioGroup: ControlCollector = (root, _nodeIndex) => {
    const parentIdMap = buildParentIdMap(root);
    const radioNodes = collectInputsByType(root, 'radio');
    const groups = groupBy(radioNodes, (node) => normalizeLower(getNodeAttr(node, 'name')) || node.id);

    const components: BaseControlComponent[] = [];
    for (const [, members] of groups) {
        if (members.length < 2) {continue;}
        const parentId = findCommonParentId(members, parentIdMap);
        const options = members.map((node) => ({
            value: normalizeLower(getNodeAttr(node, 'value')) || readNodeText(node),
            label: readNodeText(node),
            selected: normalizeLower(getNodeAttr(node, 'checked')) === 'true',
            nodeId: node.id,
        }));
        components.push({
            id: `radio_group_${members[0].id}`,
            kind: 'radio_group',
            owner: OWNER,
            capabilities: CAPABILITIES,
            source: SOURCE,
            confidence: 1,
            rootNodeId: parentId,
            controlNodeId: parentId,
            triggerNodeId: '',
            popupNodeId: '',
            labelNodeId: '',
            valueNodeId: '',
            optionNodeIds: options.map((opt) => opt.nodeId),
            state: {
                expanded: false,
                multiple: false,
                disabled: members.every((n) => normalizeLower(getNodeAttr(n, 'disabled')) === 'true'),
                readonly: false,
                focused: false,
            },
            data: {
                options,
                selectedValues: options.filter((opt) => opt.selected).map((opt) => opt.value),
                selectedLabels: options.filter((opt) => opt.selected).map((opt) => opt.label),
                optionMatchHints: options.map((opt) => opt.label),
            },
        });
    }
    return components;
};

const collectCheckboxGroup: ControlCollector = (root, _nodeIndex) => {
    const parentIdMap = buildParentIdMap(root);
    const checkboxNodes = collectInputsByType(root, 'checkbox');
    const groups = groupBy(checkboxNodes, (node) => parentIdMap[node.id] || node.id);

    const components: BaseControlComponent[] = [];
    for (const [parentId, members] of groups) {
        if (members.length < 2) {continue;}
        const options = members.map((node) => ({
            value: normalizeLower(getNodeAttr(node, 'value')) || readNodeText(node),
            label: readNodeText(node),
            selected: normalizeLower(getNodeAttr(node, 'checked')) === 'true',
            nodeId: node.id,
        }));
        components.push({
            id: `checkbox_group_${members[0].id}`,
            kind: 'checkbox_group',
            owner: OWNER,
            capabilities: CAPABILITIES,
            source: SOURCE,
            confidence: 1,
            rootNodeId: parentId,
            controlNodeId: parentId,
            triggerNodeId: '',
            popupNodeId: '',
            labelNodeId: '',
            valueNodeId: '',
            optionNodeIds: options.map((opt) => opt.nodeId),
            state: {
                expanded: false,
                multiple: true,
                disabled: members.every((n) => normalizeLower(getNodeAttr(n, 'disabled')) === 'true'),
                readonly: false,
                focused: false,
            },
            data: {
                options,
                selectedValues: options.filter((opt) => opt.selected).map((opt) => opt.value),
                selectedLabels: options.filter((opt) => opt.selected).map((opt) => opt.label),
                optionMatchHints: options.map((opt) => opt.label),
            },
        });
    }
    return components;
};

const collectCustomSelect: ControlCollector = (root, nodeIndex) => {
    const components: BaseControlComponent[] = [];
    walk(root, (node) => {
        if (node.role !== 'combobox') {return;}

        const popupNodeId = resolvePopupNodeId(node, nodeIndex);
        const options = popupNodeId ? collectPopupOptions(popupNodeId, nodeIndex) : [];

        components.push({
            id: node.id,
            kind: 'custom_select',
            owner: OWNER,
            capabilities: CAPABILITIES,
            source: SOURCE,
            confidence: 1,
            rootNodeId: node.id,
            controlNodeId: node.id,
            triggerNodeId: node.id,
            popupNodeId,
            labelNodeId: '',
            valueNodeId: '',
            optionNodeIds: options.map((opt) => opt.nodeId),
            state: {
                expanded: normalizeLower(getNodeAttr(node, 'aria-expanded')) === 'true',
                multiple: normalizeLower(getNodeAttr(node, 'aria-multiselectable')) === 'true',
                disabled: normalizeLower(getNodeAttr(node, 'disabled')) === 'true',
                readonly: normalizeLower(getNodeAttr(node, 'readonly')) === 'true',
                focused: normalizeLower(getNodeAttr(node, 'focused')) === 'true',
            },
            data: {
                options,
                selectedValues: options.filter((opt) => opt.selected).map((opt) => opt.value),
                selectedLabels: options.filter((opt) => opt.selected).map((opt) => opt.label),
                optionMatchHints: options.map((opt) => opt.label),
            },
        });
    });
    return components;
};

const resolvePopupNodeId = (comboboxNode: UnifiedNode, nodeIndex: Record<string, UnifiedNode>): string => {
    const controlsId = normalizeText(getNodeAttr(comboboxNode, 'aria-controls'));
    if (controlsId && nodeIndex[controlsId]) {return controlsId;}

    const ownsId = normalizeText(getNodeAttr(comboboxNode, 'aria-owns'));
    if (ownsId && nodeIndex[ownsId]) {return ownsId;}

    return '';
};

const collectPopupOptions = (popupNodeId: string, nodeIndex: Record<string, UnifiedNode>): OptionEntry[] => {
    const options: OptionEntry[] = [];
    const visited = new Set<string>();
    const queue = [popupNodeId];

    while (queue.length > 0) {
        const currentId = queue.shift()!;
        if (visited.has(currentId)) {continue;}
        visited.add(currentId);

        const node = nodeIndex[currentId];
        if (!node) {continue;}

        if (node.role === 'option') {
            const label = readNodeText(node);
            const value = normalizeLower(getNodeAttr(node, 'value')) || normalizeLower(getNodeAttr(node, 'data-value')) || label;
            const selected = normalizeLower(getNodeAttr(node, 'aria-selected')) === 'true'
                || normalizeLower(getNodeAttr(node, 'aria-checked')) === 'true';
            options.push({ value, label, selected, nodeId: currentId });
        }

        for (const child of node.children) {
            if (!visited.has(child.id)) {
                queue.push(child.id);
            }
        }
    }
    return options;
};

const collectInputsByType = (root: UnifiedNode, inputType: string): UnifiedNode[] => {
    const nodes: UnifiedNode[] = [];
    walk(root, (node) => {
        const tag = normalizeLower(getNodeAttr(node, 'tag'));
        const type = normalizeLower(getNodeAttr(node, 'type'));
        if (tag === 'input' && type === inputType) {
            nodes.push(node);
        }
    });
    return nodes;
};

const buildParentIdMap = (root: UnifiedNode): ParentIdMap => {
    const map: ParentIdMap = {};
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const current = stack.pop()!;
        for (const child of current.children) {
            map[child.id] = current.id;
            stack.push(child);
        }
    }
    return map;
};

const findCommonParentId = (nodes: UnifiedNode[], parentIdMap: ParentIdMap): string => {
    if (nodes.length === 0) {return '';}
    if (nodes.length === 1) {return nodes[0].id;}

    const ancestorPaths = nodes.map((node) => {
        const path: string[] = [node.id];
        let currentId: string | undefined = parentIdMap[node.id];
        while (currentId) {
            path.unshift(currentId);
            currentId = parentIdMap[currentId];
        }
        return path;
    });

    let commonId = '';
    const minLen = Math.min(...ancestorPaths.map((p) => p.length));
    for (let i = 0; i < minLen; i += 1) {
        const id = ancestorPaths[0][i];
        if (ancestorPaths.every((p) => p[i] === id)) {
            commonId = id;
        } else {
            break;
        }
    }
    return commonId;
};

const walk = (root: UnifiedNode, visitor: (node: UnifiedNode) => void): void => {
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop()!;
        visitor(node);
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
            stack.push(node.children[i]);
        }
    }
};

const groupBy = <T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const item of items) {
        const key = keyFn(item);
        const bucket = map.get(key) || [];
        bucket.push(item);
        map.set(key, bucket);
    }
    return map;
};

const readNodeText = (node: UnifiedNode): string => {
    if (node.name) {return node.name;}
    if (typeof node.content === 'string') {return node.content;}
    if (node.content?.ref) {return '';}
    for (const child of node.children) {
        if (typeof child.content === 'string') {
            return child.content;
        }
    }
    return '';
};

const normalizeLower = (value: string | undefined): string =>
    (value || '').trim().toLowerCase();

const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : undefined;
};
