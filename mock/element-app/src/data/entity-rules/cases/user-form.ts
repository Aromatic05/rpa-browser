import type { UserFormCase } from '../../../types/entity-rules';

export const userFormCases: UserFormCase[] = [
    {
        id: 'case-create-user',
        title: '用户创建表单',
        description: '填写用户核心字段后提交。',
        initialData: {
            userNo: '',
            userName: '',
            phone: '',
            role: '管理员',
        },
        expected: {
            userNo: 'USR-101',
            userName: 'charlie',
            phone: '13900003333',
            role: '业务员',
        },
        scoreRules: [
            { key: 'userNo', score: 25 },
            { key: 'userName', score: 25 },
            { key: 'phone', score: 25 },
            { key: 'role', score: 10 },
            { key: 'submit', score: 15 },
        ],
    },
];
