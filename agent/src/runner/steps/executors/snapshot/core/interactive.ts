import type { UnifiedNode } from './types';
import { getNodeAttr } from './runtime_store';

export const isStrongSemanticRole = (role: string | undefined): boolean => {
    return STRONG_SEMANTIC_ROLES.has(normalizeRole(role));
};

export const isInteractiveNode = (node: UnifiedNode): boolean => {
    if (INTERACTIVE_ROLES.has(normalizeRole(node.role))) {
        return true;
    }

    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return INTERACTIVE_TAGS.has(tag);
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();

const STRONG_SEMANTIC_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'input',
    'textarea',
    'select',
    'checkbox',
    'radio',
    'combobox',
]);

const INTERACTIVE_ROLES = new Set([...STRONG_SEMANTIC_ROLES, 'menuitem', 'tab']);
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select']);
