import type { Action } from '../shared/types.js';

type ActionPattern = string;
type ActionSubscriber = (action: Action) => void | Promise<void>;

type Subscription = {
    patterns: ActionPattern[];
    subscriber: ActionSubscriber;
};
type ActionBus = {
    subscribe: (patterns: ActionPattern[], subscriber: ActionSubscriber) => () => void;
    publish: (action: Action) => void;
};

const matchByPattern = (actionType: string, pattern: ActionPattern) => {
    if (pattern === '*') {return true;}
    const parts = pattern.split('.');
    const target = actionType.split('.');
    let pi = 0;
    let ti = 0;
    while (pi < parts.length && ti < target.length) {
        const p = parts[pi];
        if (p === '**') {return true;}
        if (p !== '*' && p !== target[ti]) {return false;}
        pi += 1;
        ti += 1;
    }
    if (pi === parts.length && ti === target.length) {return true;}
    if (pi === parts.length - 1 && parts[pi] === '**') {return true;}
    return false;
};

const matchesAnyPattern = (actionType: string, patterns: ActionPattern[]) => {
    for (const pattern of patterns) {
        if (matchByPattern(actionType, pattern)) {return true;}
    }
    return false;
};

export const createActionBus = (): ActionBus => {
    const subscriptions = new Set<Subscription>();

    const subscribe = (patterns: ActionPattern[], subscriber: ActionSubscriber) => {
        const normalized = patterns.length ? patterns : ['*'];
        const sub: Subscription = { patterns: normalized, subscriber };
        subscriptions.add(sub);
        return () => {
            subscriptions.delete(sub);
        };
    };

    const publish = (action: Action) => {
        subscriptions.forEach((sub) => {
            if (!matchesAnyPattern(action.type, sub.patterns)) {return;}
            void sub.subscriber(action);
        });
    };

    return { subscribe, publish };
};
