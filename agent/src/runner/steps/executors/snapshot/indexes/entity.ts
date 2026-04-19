import type { EntityIndex, UnifiedNode } from '../core/types';
import { buildStructureEntityIndex } from '../stages/entity_index';

export const buildEntityIndex = (root: UnifiedNode): EntityIndex => {
    return buildStructureEntityIndex(root);
};
