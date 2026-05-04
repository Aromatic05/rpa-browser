export type DslDiagnostic = {
    code: string;
    message: string;
    path?: string;
};

export const createDiagnostic = (code: string, message: string, path?: string): DslDiagnostic => ({
    code,
    message,
    path,
});
