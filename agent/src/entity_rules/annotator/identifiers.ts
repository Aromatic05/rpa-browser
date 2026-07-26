export const entityCanvasId = (entityIndex: number): string => `e${entityIndex}`;

export const columnCanvasId = (entityId: string, columnIndex: number): string => `${entityId}_col${columnIndex}`;

export const columnActionCanvasId = (
    entityId: string,
    columnIndex: number,
    actionIndex: number,
): string => `${entityId}_col${columnIndex}_act${actionIndex}`;

export const annotationCanvasId = (
    entityId: string,
    type: 'field' | 'action' | 'pagination',
    index: number,
): string => `${entityId}_${type}${index}`;

export const entityRuleId = (entityIndex: number): string => `entity_${entityIndex}`;

export const annotationRuleId = (entityRuleId: string, index: number): string => `${entityRuleId}_ann${index}`;

export const columnActionRuleId = (entityRuleId: string, index: number): string => `${entityRuleId}_colact${index}`;

export const paginationItemRuleId = (entityRuleId: string): string => `${entityRuleId}_pgitem`;

export const paginationPageRuleId = (entityRuleId: string): string => `${entityRuleId}_pgpage`;

export const paginationItemCanvasId = (entityId: string): string => `${entityId}_pgitem`;

export const paginationPageCanvasId = (entityId: string): string => `${entityId}_pgpage`;
