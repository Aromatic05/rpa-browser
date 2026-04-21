import { Alert, Button, Card, Progress, Space, Statistic, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BusinessForm } from '../../component/entity-rules/BusinessForm';
import { TaskBanner } from '../../component/entity-rules/TaskBanner';
import { getOrderFormBenchCases } from '../../service/entity-rules/case-service';
import { evaluateOrderFormCase, toAccuracy } from '../../service/entity-rules/score-service';

type Attempt = { caseId: string; ok: boolean };

export const BenchOrderForm = () => {
    const { caseId = '' } = useParams();
    const benchCases = useMemo(() => getOrderFormBenchCases(caseId, 10), [caseId]);
    const [index, setIndex] = useState(0);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [formValues, setFormValues] = useState(benchCases[0].initialData);

    const currentCase = benchCases[index];

    useEffect(() => {
        setFormValues(currentCase.initialData);
    }, [currentCase]);

    const done = attempts.length;
    const correct = attempts.filter((item) => item.ok).length;
    const accuracy = toAccuracy(correct, Math.max(1, done));

    const validate = () => {
        if (!formValues.orderNo.trim()) return '订单编号必填';
        if (!formValues.buyer.trim()) return '采购人必填';
        if (!Number(formValues.amount) || Number(formValues.amount) <= 0) return '订单金额必须大于 0';
        if (!formValues.dept.trim()) return '所属部门必填';
        return undefined;
    };

    const submit = () => {
        const error = validate();
        if (error) {
            message.error(error);
            return;
        }

        const result = evaluateOrderFormCase(currentCase, {
            orderNo: formValues.orderNo,
            buyer: formValues.buyer,
            amount: Number(formValues.amount),
            dept: formValues.dept,
        });

        setAttempts((current) => {
            const withoutCurrent = current.filter((item) => item.caseId !== currentCase.id);
            return [...withoutCurrent, { caseId: currentCase.id, ok: result.ok }];
        });

        if (result.ok) {
            message.success(`第 ${index + 1} 题提交成功，结果正确`);
            return;
        }
        message.error(`第 ${index + 1} 题提交成功，但结果错误：${result.reasons.join(' / ')}`);
    };

    const nextCase = () => {
        if (index >= benchCases.length - 1) {
            message.info('已经是最后一题');
            return;
        }
        setIndex((current) => current + 1);
    };

    const previousCase = () => {
        if (index <= 0) {
            message.info('已经是第一题');
            return;
        }
        setIndex((current) => current - 1);
    };

    return (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <TaskBanner title={`订单表单基准任务 ${index + 1} / ${benchCases.length}`} description={currentCase.description} />

            <Card>
                <Space size={24}>
                    <Statistic title="已完成" value={done} suffix={`/ ${benchCases.length}`} />
                    <Statistic title="正确数" value={correct} />
                    <Statistic title="正确率" value={`${accuracy}%`} />
                </Space>
                <Progress percent={Math.round((done / benchCases.length) * 100)} style={{ marginTop: 12 }} />
            </Card>

            <Alert
                type="info"
                showIcon
                message={`任务要求：${currentCase.title}`}
                description={
                    <Space direction="vertical" size={4}>
                        <span>{currentCase.description}</span>
                        <span>
                            目标输入：订单编号 {currentCase.expected.orderNo}，采购人 {currentCase.expected.buyer}，金额 {currentCase.expected.amount}，部门 {currentCase.expected.dept}
                        </span>
                        <span>每题必须填写完整后提交。完成 10 题后查看正确率。</span>
                    </Space>
                }
            />

            <Card title="订单维护表单">
                <BusinessForm
                    mode="form"
                    values={formValues}
                    onChange={(patch) => setFormValues((current) => ({ ...current, ...patch }))}
                    onSubmit={submit}
                    onReset={() => {
                        setFormValues(currentCase.initialData);
                        message.info('已重置本题表单');
                    }}
                    onCancel={() => {
                        setFormValues(currentCase.initialData);
                        message.warning('已取消本次编辑');
                    }}
                />
            </Card>

            <Card>
                <Space>
                    <Button onClick={previousCase}>上一题</Button>
                    <Button type="primary" onClick={nextCase}>
                        下一题
                    </Button>
                </Space>
            </Card>
        </Space>
    );
};
