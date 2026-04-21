import { Alert, Button, Card, Modal, Progress, Space, Statistic, Tag, Typography, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BusinessForm } from '../../component/entity-rules/BusinessForm';
import { BusinessTable, type OrderRowAction } from '../../component/entity-rules/BusinessTable';
import { PaginationBar } from '../../component/entity-rules/PaginationBar';
import { TaskBanner } from '../../component/entity-rules/TaskBanner';
import { getOrderListBenchCases } from '../../service/entity-rules/case-service';
import { evaluateOrderListCase, toAccuracy } from '../../service/entity-rules/score-service';
import type { OrderRecord } from '../../types/entity-rules';

const PAGE_SIZE = 10;

type Attempt = { caseId: string; ok: boolean };

export const BenchOrderList = () => {
    const { caseId = '' } = useParams();
    const benchCases = useMemo(() => getOrderListBenchCases(caseId, 10), [caseId]);
    const [index, setIndex] = useState(0);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [filters, setFilters] = useState({ orderNo: '', buyer: '', status: '全部' });
    const [appliedFilters, setAppliedFilters] = useState({ orderNo: '', buyer: '', status: '全部' });
    const [page, setPage] = useState(1);
    const [dialog, setDialog] = useState<{ open: boolean; action?: OrderRowAction; row?: OrderRecord }>({ open: false });

    const currentCase = benchCases[index];

    useEffect(() => {
        const next = { ...currentCase.initialData.filters };
        setFilters(next);
        setAppliedFilters(next);
        setPage(1);
    }, [currentCase]);

    const filteredRows = useMemo(() => {
        return currentCase.initialData.rows.filter((row) => {
            if (appliedFilters.orderNo && !row.orderNo.includes(appliedFilters.orderNo)) return false;
            if (appliedFilters.buyer && !row.buyer.includes(appliedFilters.buyer)) return false;
            if (appliedFilters.status !== '全部' && row.status !== appliedFilters.status) return false;
            return true;
        });
    }, [appliedFilters, currentCase]);

    const pageRows = useMemo(() => {
        const start = (page - 1) * PAGE_SIZE;
        return filteredRows.slice(start, start + PAGE_SIZE);
    }, [filteredRows, page]);

    const done = attempts.length;
    const correct = attempts.filter((item) => item.ok).length;
    const accuracy = toAccuracy(correct, Math.max(1, done));

    const submit = () => {
        const next = { ...filters };
        setAppliedFilters(next);
        setPage(1);

        const result = evaluateOrderListCase(currentCase, next);
        setAttempts((current) => {
            const withoutCurrent = current.filter((item) => item.caseId !== currentCase.id);
            return [...withoutCurrent, { caseId: currentCase.id, ok: result.ok }];
        });

        if (result.ok) {
            message.success(`第 ${index + 1} 题通过`);
            return;
        }
        message.error(`第 ${index + 1} 题未通过：${result.reasons.join(' / ')}`);
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
            <TaskBanner title={`订单列表基准任务 ${index + 1} / ${benchCases.length}`} description={currentCase.description} />

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
                description="每题先查询再提交。完成 10 题后看正确率。"
            />

            <Card title="查询操作区" extra={<Tag color="blue">当前筛选 {filteredRows.length} 条</Tag>}>
                <BusinessForm
                    mode="list"
                    values={filters}
                    onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
                    onSubmit={submit}
                    onReset={() => {
                        const next = { ...currentCase.initialData.filters };
                        setFilters(next);
                        setAppliedFilters(next);
                        setPage(1);
                        message.info('已重置本题筛选条件');
                    }}
                />
            </Card>

            <Card title="订单结果列表" role="table" aria-label="订单主表格">
                <BusinessTable
                    rows={pageRows}
                    onAction={(action, row) => {
                        if (action === 'delete') {
                            message.warning(`基准场景不执行删除：${row.orderNo}`);
                            return;
                        }
                        setDialog({ open: true, action, row });
                    }}
                />
                <PaginationBar page={page} pageSize={PAGE_SIZE} total={filteredRows.length} onChange={(nextPage) => setPage(nextPage)} />
            </Card>

            <Card>
                <Space>
                    <Button onClick={previousCase}>上一题</Button>
                    <Button type="primary" onClick={nextCase}>
                        下一题
                    </Button>
                </Space>
            </Card>

            <Modal
                open={dialog.open}
                title={dialog.action === 'view' ? '订单详情' : '编辑订单'}
                onCancel={() => setDialog({ open: false })}
                onOk={() => setDialog({ open: false })}
                okText="确定"
                cancelText="关闭"
            >
                {dialog.row ? (
                    <Space direction="vertical">
                        <Typography.Text>订单编号：{dialog.row.orderNo}</Typography.Text>
                        <Typography.Text>采购人：{dialog.row.buyer}</Typography.Text>
                        <Typography.Text>金额：￥{dialog.row.amount.toLocaleString('zh-CN')}</Typography.Text>
                        <Typography.Text>状态：{dialog.row.status}</Typography.Text>
                    </Space>
                ) : null}
            </Modal>
        </Space>
    );
};
