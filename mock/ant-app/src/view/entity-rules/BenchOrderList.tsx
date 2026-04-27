import { Alert, Card, List, Modal, Progress, Space, Statistic, Tag, Typography, message } from 'antd';
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
    const benchCases = useMemo(() => getOrderListBenchCases(caseId, 30), [caseId]);
    const [index, setIndex] = useState(0);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [filters, setFilters] = useState({ orderNo: '', buyer: '', status: '全部' });
    const [appliedFilters, setAppliedFilters] = useState({ orderNo: '', buyer: '', status: '全部' });
    const [page, setPage] = useState(1);
    const [dialog, setDialog] = useState<{ open: boolean; action?: OrderRowAction; row?: OrderRecord }>({ open: false });

    const currentCase = benchCases[index];

    useEffect(() => {
        if (!currentCase) return;
        const next = { ...currentCase.initialData.filters };
        setFilters(next);
        setAppliedFilters(next);
        setPage(1);
    }, [currentCase]);

    const filteredRows = useMemo(() => {
        if (!currentCase) return [] as OrderRecord[];
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
    const isFinished = done >= benchCases.length;

    const submitCurrentTask = () => {
        if (!currentCase) return;

        const next = { ...filters };
        setAppliedFilters(next);
        setPage(1);

        const result = evaluateOrderListCase(currentCase, next);
        setAttempts((current) => {
            const withoutCurrent = current.filter((item) => item.caseId !== currentCase.id);
            return [...withoutCurrent, { caseId: currentCase.id, ok: result.ok }];
        });

        if (result.ok) {
            message.success(`任务 ${index + 1}/30 正确`);
        } else {
            message.error(`任务 ${index + 1}/30 错误：${result.reasons.join(' / ')}`);
        }

        if (index < benchCases.length - 1) {
            setIndex((current) => current + 1);
        }
    };

    return (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <TaskBanner title={`订单列表 30 题联测（当前 ${Math.min(index + 1, benchCases.length)} / ${benchCases.length}）`} description="单页一次完成 30 题，不再拆分多轮。" />

            <Card>
                <Space size={24}>
                    <Statistic title="已完成" value={done} suffix={`/ ${benchCases.length}`} />
                    <Statistic title="正确数" value={correct} />
                    <Statistic title="正确率" value={`${accuracy}%`} />
                </Space>
                <Progress percent={Math.round((done / Math.max(1, benchCases.length)) * 100)} style={{ marginTop: 12 }} />
            </Card>

            {currentCase ? (
                <Alert
                    type="info"
                    showIcon
                    message={`任务要求：${currentCase.title}`}
                    description={
                        <Space direction="vertical" size={4}>
                            <Typography.Text>{currentCase.description}</Typography.Text>
                            <Typography.Text>
                                目标筛选：订单编号 {currentCase.expected.filters.orderNo || '（留空）'}，采购人 {currentCase.expected.filters.buyer || '（留空）'}，状态 {currentCase.expected.filters.status}
                            </Typography.Text>
                            <Typography.Text>预期返回条数：{currentCase.expected.resultCount}</Typography.Text>
                        </Space>
                    }
                />
            ) : null}

            <Card title="查询操作区" extra={<Tag color="blue">当前筛选 {filteredRows.length} 条</Tag>}>
                <BusinessForm
                    mode="list"
                    values={filters}
                    onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
                    onSubmit={submitCurrentTask}
                    onReset={() => {
                        if (!currentCase) return;
                        const next = { ...currentCase.initialData.filters };
                        setFilters(next);
                        setAppliedFilters(next);
                        setPage(1);
                        message.info('已重置当前任务筛选条件');
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

            <Card title="任务状态">
                <List
                    size="small"
                    dataSource={benchCases}
                    renderItem={(item, itemIndex) => {
                        const attempt = attempts.find((entry) => entry.caseId === item.id);
                        const color = !attempt ? 'default' : attempt.ok ? 'success' : 'error';
                        return (
                            <List.Item>
                                <Space>
                                    <Tag color={itemIndex === index && !isFinished ? 'processing' : undefined}>{itemIndex + 1}</Tag>
                                    <Typography.Text>{item.title}</Typography.Text>
                                    <Tag color={color}>{!attempt ? '未提交' : attempt.ok ? '正确' : '错误'}</Tag>
                                </Space>
                            </List.Item>
                        );
                    }}
                />
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
