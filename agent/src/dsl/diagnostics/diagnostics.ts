export type DslDiagnostic = {
    code: string;
    message: string;
};

export const createDiagnostic = (code: string, message: string): DslDiagnostic => ({
    code,
    message,
});
