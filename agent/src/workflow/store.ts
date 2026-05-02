export type NamedStore<T extends { name: string }> = {
    get: (name: string) => T | null;
    list: () => T[];
    save: (value: T) => T;
    delete: (name: string) => boolean;
};

export type WorkflowCodec<T extends { name: string }> = {
    kind: 'recording' | 'checkpoint' | 'dsl' | 'entity_rules';
    is: (value: unknown) => value is T;
    load: (name: string) => T | null;
    list: () => T[];
    save: (value: T) => T;
    delete: (name: string) => boolean;
};

export const createNamedStore = <T extends { name: string }>(codec: WorkflowCodec<T>): NamedStore<T> => ({
    get: (name) => codec.load(name),
    list: () => codec.list(),
    save: (value) => codec.save(value),
    delete: (name) => codec.delete(name),
});
