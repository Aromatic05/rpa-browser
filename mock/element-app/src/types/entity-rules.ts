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

export type UserRecord = {
    userNo: string;
    userName: string;
    phone: string;
    status: string;
};

export type UserListCase = {
    id: string;
    title: string;
    description: string;
    initialData: {
        filters: { userNo: string; userName: string; status: string };
        rows: UserRecord[];
    };
    expected: {
        filters: { userNo: string; userName: string; status: string };
    };
    scoreRules: Array<{ key: string; score: number }>;
};

export type UserFormCase = {
    id: string;
    title: string;
    description: string;
    initialData: {
        userNo: string;
        userName: string;
        phone: string;
        role: string;
    };
    expected: {
        userNo: string;
        userName: string;
        phone: string;
        role: string;
    };
    scoreRules: Array<{ key: string; score: number }>;
};
