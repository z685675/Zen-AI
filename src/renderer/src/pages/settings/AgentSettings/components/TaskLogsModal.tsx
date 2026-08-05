import { useTaskLogs } from '@renderer/hooks/agents/useTasks'
import { Modal, Spin, Table, Tag } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

type TaskLogsModalProps = {
  open: boolean
  taskId: string | null
  taskName: string
  onClose: () => void
}

const TaskLogsModal: FC<TaskLogsModalProps> = ({ open, taskId, taskName, onClose }) => {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const { logs, isLoading } = useTaskLogs(open ? taskId : null)

  const columns = [
    {
      title: t('agent.cherryClaw.tasks.logs.runAt'),
      dataIndex: 'run_at',
      key: 'run_at',
      width: 180,
      render: (val: string) => new Date(val).toLocaleString(locale)
    },
    {
      title: t('agent.cherryClaw.tasks.logs.duration'),
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 100,
      render: (val: number, record: any) => {
        if (record.status === 'running' || record.status === 'waiting_user') return '-'
        if (val < 1000) return `${val}ms`
        if (val < 60_000) return `${(val / 1000).toFixed(1)}s`
        return `${(val / 60_000).toFixed(1)}m`
      }
    },
    {
      title: t('agent.cherryClaw.tasks.logs.status'),
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (val: string) => {
        const color =
          val === 'success' ? 'green' : val === 'running' ? 'processing' : val === 'waiting_user' ? 'warning' : 'red'
        const label =
          val === 'waiting_user'
            ? t('agent.cherryClaw.tasks.logs.waitingUser', 'Waiting for user')
            : val === 'stalled'
              ? t('agent.cherryClaw.tasks.logs.stalled', '疑似卡住')
              : val
        return <Tag color={color}>{label}</Tag>
      }
    },
    {
      title: t('agent.cherryClaw.tasks.logs.result'),
      dataIndex: 'result',
      key: 'result',
      ellipsis: true,
      render: (val: string | null, record: any) =>
        record.status === 'waiting_user' ? (
          t('agent.cherryClaw.tasks.logs.waitingUserDesc', 'Waiting for browser handoff')
        ) : record.status === 'error' || record.status === 'stalled' ? (
          <span className="text-red-500">{record.error}</span>
        ) : (
          (val ?? '-')
        )
    }
  ]

  return (
    <Modal
      open={open}
      title={`${t('agent.cherryClaw.tasks.logs.label')} — ${taskName}`}
      onCancel={onClose}
      footer={null}
      width={700}
      transitionName="animation-move-down"
      destroyOnClose>
      {isLoading ? (
        <div className="flex justify-center py-8">
          <Spin />
        </div>
      ) : logs.length === 0 ? (
        <div className="py-8 text-center text-gray-400">{t('agent.cherryClaw.tasks.logs.empty')}</div>
      ) : (
        <Table dataSource={logs} columns={columns} rowKey="id" size="small" pagination={false} scroll={{ y: 400 }} />
      )}
    </Modal>
  )
}

export default TaskLogsModal
