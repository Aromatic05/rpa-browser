import type { UserListCase } from '../../../types/entity-rules';
import { fixtureUserRows } from '../fixtures/user-list';

export const userListCases: UserListCase[] = [
    {
        id: 'case-active-user-filter',
        title: '用户列表筛选',
        description: '输入用户名并选择状态后查询。',
        initialData: {
            filters: { userNo: '', userName: '', status: '全部' },
            rows: fixtureUserRows,
        },
        expected: {
            filters: { userNo: '', userName: 'alice', status: '启用' },
        },
        scoreRules: [
            { key: 'userName', score: 35 },
            { key: 'status', score: 35 },
            { key: 'submit', score: 30 },
        ],
    },
    {
        id: 'case-user-no-filter',
        title: '用户编号筛选',
        description: '输入用户编号后执行查询。',
        initialData: {
            filters: { userNo: '', userName: '', status: '全部' },
            rows: fixtureUserRows,
        },
        expected: {
            filters: { userNo: 'USR-018', userName: '', status: '全部' },
        },
        scoreRules: [
            { key: 'userNo', score: 65 },
            { key: 'submit', score: 35 },
        ],
    },
    {
        id: 'case-stopped-user',
        title: '停用用户筛选',
        description: '筛选用户名 bob 且状态停用。',
        initialData: {
            filters: { userNo: '', userName: '', status: '全部' },
            rows: fixtureUserRows,
        },
        expected: {
            filters: { userNo: '', userName: 'bob', status: '停用' },
        },
        scoreRules: [
            { key: 'userName', score: 35 },
            { key: 'status', score: 35 },
            { key: 'submit', score: 30 },
        ],
    },
];
