import { isAssistantModelAllowed } from '@renderer/config/agentModelPolicy'
import { useApiModels } from '@renderer/hooks/agents/useModels'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setActiveAgentId, setActiveSessionIdAction } from '@renderer/store/runtime'
import type { AutomationOverview, AutomationRequest, AutomationTaskInput } from '@shared/agents/automation'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  QRCode,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  TimePicker,
  Typography
} from 'antd'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

const { Paragraph, Text, Title } = Typography
type Task = AutomationOverview['tasks'][number]

type AutomationSettingsProps = {
  embedded?: boolean
  initialTab?: 'wechat' | 'schedule'
  onNavigateToSession?: () => void
}

/** New opt-in interface. Legacy records and their disabled APIs are deliberately untouched. */
export default function AutomationSettings({
  embedded = false,
  initialTab = 'wechat',
  onNavigateToSession
}: AutomationSettingsProps) {
  const { t, i18n } = useTranslation()
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { models } = useApiModels()
  const developer = useAppSelector((state) => state.settings.enableDeveloperMode)
  const policy = useAppSelector((state) => state.llm.modelPolicy?.policy)
  const [data, setData] = useState<AutomationOverview>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Task | 'new'>()
  const [form] = Form.useForm()
  const [schedule, setSchedule] = useState('once')
  const load = useCallback(async () => {
    const result = await window.api.assistantAutomation({ action: 'status' })
    if (result.ok) {
      setData(result.data)
      // A successful status poll does not mean the preceding bind/save operation succeeded.
      setError((current) => (current === 'automation_connection_failed' ? '' : current))
    } else setError(result.code)
  }, [])
  useEffect(() => {
    let mounted = true
    const refresh = async () => {
      if (mounted)
        await load().catch(() => {
          if (mounted) setError('automation_connection_failed')
        })
    }
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 5000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [load])
  const act = useCallback(async (request: AutomationRequest) => {
    setBusy(true)
    try {
      const response = await window.api.assistantAutomation(request)
      if (!response.ok) {
        setError(response.code)
        return false
      }
      setData(response.data)
      setError('')
      return true
    } catch {
      setError('automation_connection_failed')
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  const confirm = (onOk: () => Promise<unknown>, description = t('automation.confirmation')) =>
    Modal.confirm({
      title: t('automation.confirmTitle'),
      content: description,
      okText: t('automation.confirm'),
      cancelText: t('automation.cancel'),
      onOk: async () => {
        await onOk()
      }
    })
  const openSession = (sessionId: string) => {
    dispatch(setActiveAgentId(DEFAULT_OPENCODE_AGENT_ID))
    dispatch(setActiveSessionIdAction({ agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId }))
    onNavigateToSession?.()
    navigate('/new-assistant')
  }
  const modelOptions = useMemo(
    () =>
      models
        .filter((model) => isAssistantModelAllowed(model, developer, policy))
        .filter((model) => !/image-generation|embedding|rerank/i.test(`${model.endpoint_type} ${model.id}`))
        .map((model) => ({ value: model.id, label: `${model.name} · ${model.provider_name || ''}` })),
    [models, developer, policy]
  )
  const edit = (task?: Task) => {
    setEditing(task || 'new')
    const simpleCron = task?.scheduleType === 'cron' ? /^(\d+) (\d+) \* \* (\*|[0-6])$/.exec(task.scheduleValue) : null
    const scheduleType = simpleCron ? (simpleCron[3] === '*' ? 'daily' : 'weekly') : task?.scheduleType || 'once'
    setSchedule(scheduleType)
    form.setFieldsValue({
      name: task?.name || '',
      prompt: task?.prompt || '',
      model: task?.model || undefined,
      scheduleType,
      scheduleValue: task?.scheduleValue || '60',
      time: dayjs()
        .hour(simpleCron ? Number(simpleCron[2]) : 9)
        .minute(simpleCron ? Number(simpleCron[1]) : 0)
        .second(0),
      weekday: simpleCron && simpleCron[3] !== '*' ? Number(simpleCron[3]) : 1,
      date: task?.scheduleType === 'once' ? dayjs(task.scheduleValue) : dayjs().add(5, 'minute'),
      notify: task?.notify || false,
      authorized: false
    })
  }
  const save = async () => {
    const values = await form.validateFields().catch(() => undefined)
    if (!values) return
    const isCalendar = ['daily', 'weekly'].includes(values.scheduleType)
    const task: AutomationTaskInput = {
      name: values.name,
      prompt: values.prompt,
      model: values.model,
      scheduleType: isCalendar ? 'cron' : values.scheduleType,
      scheduleValue: isCalendar
        ? `${values.time.minute()} ${values.time.hour()} * * ${values.scheduleType === 'weekly' ? values.weekday : '*'}`
        : values.scheduleType === 'once'
          ? values.date.toISOString()
          : String(values.scheduleValue),
      notify: Boolean(values.notify),
      authorized: true
    }
    const success = await act(
      editing === 'new' ? { action: 'createTask', task } : { action: 'updateTask', id: (editing as Task).id, task }
    )
    if (success) setEditing(undefined)
  }
  const stateLabel = (value: string) => t('automation.states.' + value, { defaultValue: value })
  const failure = error || data?.connection.reason
  const failureKey = 'automation.errors.' + failure

  return (
    <div style={{ flex: 1, height: embedded ? '100%' : undefined, overflow: 'auto', padding: embedded ? 16 : 24 }}>
      {!embedded && <Title level={3}>{t('automation.title')}</Title>}
      <Alert type="info" showIcon message={t('automation.localOnly')} description={t('automation.scope')} />
      {failure && (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message={t('automation.error')}
          description={i18n.exists(failureKey) ? t(failureKey) : t('automation.genericError')}
        />
      )}
      <Tabs
        defaultActiveKey={initialTab}
        style={{ marginTop: 16 }}
        items={[
          {
            key: 'wechat',
            label: t('automation.wechat'),
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Space wrap>
                  <Tag>{stateLabel(data?.connection.status || 'disconnected')}</Tag>
                  <Button
                    loading={busy}
                    disabled={['logging_in', 'awaiting_confirmation', 'connected'].includes(
                      data?.connection.status || ''
                    )}
                    onClick={() => confirm(() => act({ action: 'login' }), t('automation.loginConsent'))}>
                    {t('automation.scan')}
                  </Button>
                  <Button
                    disabled={busy || data?.connection.status === 'disconnected'}
                    onClick={() => confirm(() => act({ action: 'disconnect' }), t('automation.disconnectHint'))}>
                    {t('automation.disconnect')}
                  </Button>
                  <Button onClick={() => void load()}>{t('automation.refresh')}</Button>
                </Space>
                {data?.connection.qr && <QRCode value={data.connection.qr} size={240} />}
                {data?.connection.status === 'awaiting_confirmation' && (
                  <Alert
                    type="warning"
                    message={t('automation.ownerConfirm', { owner: data.connection.owner })}
                    action={
                      <Button
                        loading={busy}
                        onClick={() => confirm(() => act({ action: 'confirm', authorized: true }))}>
                        {t('automation.confirmOwner')}
                      </Button>
                    }
                  />
                )}
                <Paragraph>{t('automation.wechatHelp')}</Paragraph>
                <Space>
                  <Button
                    disabled={!data?.connection.sessionId}
                    onClick={() => data?.connection.sessionId && openSession(data.connection.sessionId)}>
                    {t('automation.openConversation')}
                  </Button>
                  <Button
                    disabled={busy || data?.connection.status !== 'connected'}
                    onClick={() => confirm(() => act({ action: 'newChat' }))}>
                    {t('automation.newChat')}
                  </Button>
                  <Button
                    disabled={busy || !data?.connection.sessionId || !data.connection.enabled}
                    onClick={() =>
                      data?.connection.sessionId &&
                      void act({ action: 'sync', sessionId: data.connection.sessionId, enabled: false })
                    }>
                    {t('automation.disableSync')}
                  </Button>
                </Space>
                <Title level={5}>{t('automation.conversations')}</Title>
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={data?.sessions || []}
                  pagination={{ pageSize: 5 }}
                  columns={[
                    { title: t('automation.name'), dataIndex: 'name' },
                    {
                      title: t('automation.actions'),
                      render: (_, row) => (
                        <Space>
                          <Button size="small" onClick={() => openSession(row.id)}>
                            {t('automation.openConversation')}
                          </Button>
                          {row.current ? (
                            <Tag>{t('automation.syncing')}</Tag>
                          ) : (
                            <Button
                              size="small"
                              disabled={busy || data?.connection.status !== 'connected'}
                              onClick={() => confirm(() => act({ action: 'sync', sessionId: row.id, enabled: true }))}>
                              {t('automation.restoreSync')}
                            </Button>
                          )}
                        </Space>
                      )
                    }
                  ]}
                />
                <Title level={5}>{t('automation.deliveries')}</Title>
                <Paragraph type="secondary">{t('automation.deliveryHint')}</Paragraph>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={data?.deliveries || []}
                  pagination={{ pageSize: 10 }}
                  columns={[
                    {
                      title: t('automation.time'),
                      render: (_, row) => dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss')
                    },
                    { title: t('automation.status'), render: (_, row) => stateLabel(row.state) },
                    {
                      title: t('automation.reason'),
                      render: (_, row) => (row.reason ? t('automation.deliveryFailed') : '—')
                    },
                    {
                      title: t('automation.actions'),
                      render: (_, row) =>
                        ['failed', 'unknown', 'pending', 'retry_wait'].includes(row.state) && (
                          <Space>
                            <Button
                              size="small"
                              disabled={busy}
                              onClick={() =>
                                confirm(
                                  () => act({ action: 'delivery', id: row.id, decision: 'retry', confirmed: true }),
                                  t('automation.retryWarning')
                                )
                              }>
                              {t('automation.resend')}
                            </Button>
                            <Button
                              size="small"
                              disabled={busy}
                              onClick={() =>
                                void act({ action: 'delivery', id: row.id, decision: 'cancel', confirmed: true })
                              }>
                              {t('automation.cancelDelivery')}
                            </Button>
                          </Space>
                        )
                    }
                  ]}
                />
              </Space>
            )
          },
          {
            key: 'schedule',
            label: t('automation.schedule'),
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Space>
                  <Button type="primary" onClick={() => edit()}>
                    {t('automation.addTask')}
                  </Button>
                  {!!data?.legacyTasks.length && (
                    <Select
                      style={{ minWidth: 180 }}
                      value={undefined}
                      placeholder={t('automation.copyLegacyTask')}
                      options={data.legacyTasks.map((task) => ({ value: task.id, label: task.name }))}
                      onChange={(id) => {
                        const task = data.legacyTasks.find((row) => row.id === id)
                        if (!task) return
                        edit({
                          ...task,
                          notify: false,
                          notificationNeedsConfirmation: false,
                          status: 'paused',
                          nextRun: null,
                          lastResult: null
                        })
                        setEditing('new')
                      }}
                    />
                  )}
                  <Text type="secondary">
                    {t('automation.scheduleHint', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
                  </Text>
                </Space>
                <Table
                  rowKey="id"
                  dataSource={data?.tasks || []}
                  pagination={{ pageSize: 10 }}
                  scroll={{ x: 800 }}
                  columns={[
                    { title: t('automation.name'), dataIndex: 'name' },
                    {
                      title: t('automation.status'),
                      render: (_, row) => (
                        <Space direction="vertical">
                          {stateLabel(row.status)}
                          {row.notificationNeedsConfirmation && (
                            <Text type="warning">{t('automation.notificationNeedsConfirmation')}</Text>
                          )}
                        </Space>
                      )
                    },
                    {
                      title: t('automation.nextRun'),
                      render: (_, row) => (row.nextRun ? dayjs(row.nextRun).format('YYYY-MM-DD HH:mm:ss') : '—')
                    },
                    {
                      title: t('automation.actions'),
                      render: (_, row) => (
                        <Space wrap>
                          <Button size="small" onClick={() => edit(row)}>
                            {t('automation.edit')}
                          </Button>
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() =>
                              void act({
                                action: 'task',
                                id: row.id,
                                operation: row.status === 'active' ? 'pause' : 'resume'
                              })
                            }>
                            {t(row.status === 'active' ? 'automation.pause' : 'automation.resume')}
                          </Button>
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() => confirm(() => act({ action: 'task', id: row.id, operation: 'run' }))}>
                            {t('automation.run')}
                          </Button>
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() => void act({ action: 'task', id: row.id, operation: 'stop' })}>
                            {t('automation.stop')}
                          </Button>
                          <Button
                            size="small"
                            danger
                            disabled={busy}
                            onClick={() => confirm(() => act({ action: 'task', id: row.id, operation: 'delete' }))}>
                            {t('automation.delete')}
                          </Button>
                        </Space>
                      )
                    }
                  ]}
                />
                <Title level={5}>{t('automation.runHistory')}</Title>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={data?.runs || []}
                  pagination={{ pageSize: 10 }}
                  columns={[
                    { title: t('automation.time'), render: (_, row) => dayjs(row.runAt).format('YYYY-MM-DD HH:mm:ss') },
                    { title: t('automation.status'), render: (_, row) => stateLabel(row.status) },
                    {
                      title: t('automation.result'),
                      render: (_, row) => (
                        <Paragraph ellipsis={{ rows: 2, expandable: true }}>
                          {row.result || (row.error ? t('automation.taskFailed') : '')}
                        </Paragraph>
                      )
                    },
                    {
                      title: t('automation.actions'),
                      render: (_, row) =>
                        row.sessionId && (
                          <Button size="small" onClick={() => openSession(row.sessionId!)}>
                            {t('automation.openConversation')}
                          </Button>
                        )
                    }
                  ]}
                />
              </Space>
            )
          }
        ]}
      />
      <Modal
        open={Boolean(editing)}
        title={t(editing === 'new' ? 'automation.addTask' : 'automation.editTask')}
        onCancel={() => setEditing(undefined)}
        onOk={() => void save()}
        confirmLoading={busy}
        destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('automation.name')} rules={[{ required: true }]}>
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item name="prompt" label={t('automation.taskPrompt')} rules={[{ required: true }]}>
            <Input.TextArea rows={4} maxLength={24000} />
          </Form.Item>
          <Form.Item name="model" label={t('automation.model')}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={modelOptions}
              placeholder={t('automation.defaultModel')}
            />
          </Form.Item>
          <Form.Item name="scheduleType" label={t('automation.scheduleRule')}>
            <Select
              onChange={setSchedule}
              options={[
                { value: 'once', label: t('automation.once') },
                { value: 'daily', label: t('automation.daily') },
                { value: 'weekly', label: t('automation.weekly') },
                { value: 'interval', label: t('automation.interval') },
                { value: 'cron', label: t('automation.cron') }
              ]}
            />
          </Form.Item>
          {['daily', 'weekly'].includes(schedule) ? (
            <>
              <Form.Item name="time" label={t('automation.time')} rules={[{ required: true }]}>
                <TimePicker format="HH:mm" />
              </Form.Item>
              {schedule === 'weekly' && (
                <Form.Item name="weekday" label={t('automation.weekday')}>
                  <Select
                    options={Array.from({ length: 7 }, (_, value) => ({
                      value,
                      label: dayjs().day(value).format('dddd')
                    }))}
                  />
                </Form.Item>
              )}
            </>
          ) : (
            <>
              {schedule === 'once' ? (
                <Form.Item name="date" label={t('automation.time')} rules={[{ required: true }]}>
                  <DatePicker showTime />
                </Form.Item>
              ) : (
                <Form.Item
                  name="scheduleValue"
                  label={t(schedule === 'interval' ? 'automation.minutes' : 'automation.cronRule')}
                  rules={[{ required: true }]}>
                  {schedule === 'interval' ? <InputNumber min={1} max={525600} /> : <Input placeholder="0 9 * * *" />}
                </Form.Item>
              )}
            </>
          )}
          {schedule === 'cron' && <Paragraph type="secondary">{t('automation.cronHelp')}</Paragraph>}
          <Form.Item name="notify" valuePropName="checked">
            <Checkbox disabled={!data?.connection.enabled}>{t('automation.notifyWechat')}</Checkbox>
          </Form.Item>
          <Form.Item
            name="authorized"
            valuePropName="checked"
            rules={[
              {
                validator: (_, value) =>
                  value ? Promise.resolve() : Promise.reject(new Error(t('automation.mustAuthorize')))
              }
            ]}>
            <Checkbox>{t('automation.taskConsent')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
