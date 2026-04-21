export type ScoreItem = {
    key: string;
    ok: boolean;
    score: number;
    expected?: unknown;
    actual?: unknown;
};

export type ScoreResult = {
    caseId: string;
    score: number;
    maxScore: number;
    items: ScoreItem[];
};

export type OrderRecord = {
    orderNo: string;
    buyer: string;
    amount: number;
    status: string;
};

export type OrderListCase = {
    id: string;
    title: string;
    description: string;
    initialData: {
        filters: { orderNo: string; buyer: string; status: string };
        rows: OrderRecord[];
    };
    expected: {
        filters: { orderNo: string; buyer: string; status: string };
        resultCount: number;
    };
    scoreRules: Array<{ key: string; score: number }>;
};

export type OrderFormCase = {
    id: string;
    title: string;
    description: string;
    initialData: {
        orderNo: string;
        buyer: string;
        amount: number;
        dept: string;
        remark: string;
    };
    expected: {
        orderNo: string;
        buyer: string;
        amount: number;
        dept: string;
    };
    scoreRules: Array<{ key: string; score: number }>;
};
