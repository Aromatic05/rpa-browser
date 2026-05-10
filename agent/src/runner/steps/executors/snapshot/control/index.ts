export type {
    ControlRef,
    ControlKind,
    BaseControlComponent,
    ControlIndex,
    ControlCollector,
    ControlRegistry,
    ControlState,
} from './types';

export {
    createControlRegistry,
    registerControlCollector,
    listControlCollectors,
} from './registry';

export { collectControlComponents, buildControlRef } from './collect';

export { attachControlRefsToNodes } from './attach';
