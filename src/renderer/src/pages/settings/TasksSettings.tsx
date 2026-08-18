import { PlusOutlined } from '@ant-design/icons'
import ListItem from '@renderer/components/ListItem'
import Scrollbar from '@renderer/components/Scrollbar'
import {
  findAgentModelId,
  getAgentModelProviderId,
  isAssistantModelAllowed,
  isAssistantModelIdentifierAllowed
} from '@renderer/config/agentModelPolicy'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useChannels } from '@renderer/hooks/agents/useChannels'
import { useApiModels } from '@renderer/hooks/agents/useModels'
import { useTaskLogs } from '@renderer/hooks/agents/useTasks'
import { useEnableDeveloperMode } from '@renderer/hooks/useSettings'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setActiveAgentId, setActiveSessionIdAction } from '@renderer/store/runtime'
import type {
  ApiModel,
  CreateTaskRequest,
  ScheduledTaskEntity,
  TaskRunLogEntity,
  UpdateTaskRequest
} from '@renderer/types'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import type { ModelPolicy } from '@shared/config/modelPolicy'
import {
  Alert,
  Button,
  DatePicker,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Table,
  Tag,
  TimePicker,
  Tooltip
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import type { TFunction } from 'i18next'
import {
  CalendarClock,
  Clock,
  ExternalLink,
  History,
  Info,
  Maximize2,
  Pause,
  Play,
  Repeat2,
  RotateCcw,
  Search,
  Trash2
} from 'lucide-react'
import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { mutate } from 'swr'

import { SettingContainer, SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '.'

// --------------- Types ---------------

type AgentInfo = { id: string; name: string; model: string }
type ChannelInfo = { id: string; name: string; isActive?: boolean; hasActiveChatIds?: boolean }

const isTaskModel = (model: ApiModel): boolean => {
  if (model.endpoint_type === 'image-generation' || model.endpoint_type === 'jina-rerank') return false
  const identifier = `${model.id} ${model.provider_model_id ?? ''}`
  return !/(embedding|rerank|text-to-image|image-generation)/i.test(identifier)
}

const getTaskModelLabel = (model: ApiModel): string => {
  const name = model.name || model.provider_model_id || model.id
  return model.provider_name ? `${name} | ${model.provider_name}` : name
}

type TaskModelOption = { value: string; label: string; disabled?: boolean }

const getTaskModelOptions = (
  models: ApiModel[],
  selectedModelId: string | undefined | null,
  enableDeveloperMode: boolean,
  policy?: ModelPolicy
): TaskModelOption[] => {
  const availableModels = models
    .filter(isTaskModel)
    .filter((model) => isAssistantModelAllowed(model, enableDeveloperMode, policy))
  const options: TaskModelOption[] = availableModels.map((model) => ({
    value: model.id,
    label: getTaskModelLabel(model)
  }))

  if (selectedModelId && !availableModels.some((model) => model.id === selectedModelId)) {
    const selectedModel = models.find((model) => model.id === selectedModelId)
    options.unshift({
      value: selectedModelId,
      label: selectedModel ? getTaskModelLabel(selectedModel) : selectedModelId,
      // Keep an existing non-standard task visible without making it selectable
      // while developer mode is disabled.
      disabled: selectedModel ? !isAssistantModelAllowed(selectedModel, enableDeveloperMode, policy) : true
    })
  }

  return options
}

const getDefaultTaskModelId = (
  models: ApiModel[],
  fallbackModel: string | undefined,
  enableDeveloperMode: boolean,
  policy?: ModelPolicy
) => {
  const preferredProviderId = getAgentModelProviderId(fallbackModel)
  if (policy?.rules.applyToNewSessions !== false) {
    const configuredDefault = policy?.defaults.assistantNewSession ?? 'gpt-5.6-luna'
    const remoteDefault = findAgentModelId(models, configuredDefault, preferredProviderId)
    if (remoteDefault && isAssistantModelIdentifierAllowed(remoteDefault, enableDeveloperMode, policy)) {
      return remoteDefault
    }
  }
  if (fallbackModel && isAssistantModelIdentifierAllowed(fallbackModel, enableDeveloperMode, policy)) {
    return fallbackModel
  }
  return (
    policy?.assistant.fallbackModels
      .map((candidate) => findAgentModelId(models, candidate, preferredProviderId))
      .find((candidate) => isAssistantModelIdentifierAllowed(candidate, enableDeveloperMode, policy)) ??
    models.find((model) => isAssistantModelAllowed(model, enableDeveloperMode, policy))?.id ??
    ''
  )
}

const ScheduleTypeHelp: FC<{ type: 'cron' | 'interval' | 'once' }> = ({ type }) => {
  const { t } = useTranslation()
  const help = {
    cron: t(
      'agent.cherryClaw.tasks.scheduleTypeHelp.cron',
      '按固定时间执行。选择每天、工作日、每周或每月，再选择具体时间，无需填写 Cron 语法。'
    ),
    interval: t(
      'agent.cherryClaw.tasks.scheduleTypeHelp.interval',
      '按时间间隔重复执行。示例：30 表示每 30 分钟执行一次。'
    ),
    once: t('agent.cherryClaw.tasks.scheduleTypeHelp.once', '只在指定的日期和时间执行一次，完成后自动结束。')
  }
  return (
    <Tooltip title={help[type]}>
      <Info size={13} className="cursor-help text-(--color-text-3)" />
    </Tooltip>
  )
}

type FixedScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly'
type FixedScheduleConfig = {
  frequency: FixedScheduleFrequency
  time: string
  weekday: string
  dayOfMonth: string
}

const DEFAULT_FIXED_SCHEDULE: FixedScheduleConfig = {
  frequency: 'daily',
  time: '09:00',
  weekday: '1',
  dayOfMonth: '1'
}

const WEEKDAY_VALUES = ['1', '2', '3', '4', '5', '6', '0']
const WEEKDAY_FALLBACKS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const getWeekdayOptions = (t: TFunction) =>
  WEEKDAY_VALUES.map((value, index) => ({
    value,
    label: t('agent.cherryClaw.tasks.fixedSchedule.weekday.' + value, WEEKDAY_FALLBACKS[index])
  }))

const getDayOfMonthOptions = (t: TFunction) =>
  Array.from({ length: 31 }, (_, index) => ({
    value: String(index + 1),
    label: t('agent.cherryClaw.tasks.fixedSchedule.dayOfMonthValue', `${index + 1} 号`, { day: index + 1 })
  }))

const parseFixedCron = (value: string): FixedScheduleConfig | null => {
  const parts = value.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  const numericMinute = Number(minute)
  const numericHour = Number(hour)
  if (
    !/^\d{1,2}$/.test(minute) ||
    !/^\d{1,2}$/.test(hour) ||
    numericMinute < 0 ||
    numericMinute > 59 ||
    numericHour < 0 ||
    numericHour > 23
  ) {
    return null
  }

  const time = `${String(numericHour).padStart(2, '0')}:${String(numericMinute).padStart(2, '0')}`
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return { ...DEFAULT_FIXED_SCHEDULE, frequency: 'daily', time }
  }
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return { ...DEFAULT_FIXED_SCHEDULE, frequency: 'weekdays', time }
  }
  if (dayOfMonth === '*' && month === '*' && /^\d$/.test(dayOfWeek) && Number(dayOfWeek) <= 6) {
    return { ...DEFAULT_FIXED_SCHEDULE, frequency: 'weekly', time, weekday: dayOfWeek }
  }
  if (month === '*' && dayOfWeek === '*' && /^\d{1,2}$/.test(dayOfMonth)) {
    const numericDay = Number(dayOfMonth)
    if (numericDay >= 1 && numericDay <= 31) {
      return { ...DEFAULT_FIXED_SCHEDULE, frequency: 'monthly', time, dayOfMonth }
    }
  }
  return null
}

const buildFixedCron = (config: FixedScheduleConfig): string => {
  const [hour, minute] = config.time.split(':').map(Number)
  const dayOfMonth = config.frequency === 'monthly' ? config.dayOfMonth : '*'
  const dayOfWeek = config.frequency === 'weekdays' ? '1-5' : config.frequency === 'weekly' ? config.weekday : '*'
  return `${minute} ${hour} ${dayOfMonth} * ${dayOfWeek}`
}

const toTimeValue = (time: string): Dayjs => {
  const [hour, minute] = time.split(':').map(Number)
  return dayjs().hour(hour).minute(minute).second(0).millisecond(0)
}

const getDisabledScheduleTime = (current: Dayjs | null) => {
  if (!current || !current.isSame(dayjs(), 'day')) return {}

  const now = dayjs()
  return {
    disabledHours: () => Array.from({ length: now.hour() }, (_, index) => index),
    disabledMinutes: (hour: number) =>
      hour === now.hour() ? Array.from({ length: now.minute() }, (_, index) => index) : [],
    disabledSeconds: (hour: number, minute: number) =>
      hour === now.hour() && minute === now.minute()
        ? Array.from({ length: now.second() + 1 }, (_, index) => index)
        : []
  }
}

const describeFixedCron = (
  value: string,
  labels: Record<FixedScheduleFrequency, string>,
  legacyLabel: string,
  weekdayOptions: Array<{ value: string; label: string }>,
  everyWeekLabel: string,
  monthlyLabel: string
): string => {
  const config = parseFixedCron(value)
  if (!config) return legacyLabel
  const suffix =
    config.frequency === 'weekly'
      ? ['（', weekdayOptions.find((option) => option.value === config.weekday)?.label ?? everyWeekLabel, '）'].join('')
      : config.frequency === 'monthly'
        ? ['（', monthlyLabel.replace('{{day}}', config.dayOfMonth), '）'].join('')
        : ''
  return [labels[config.frequency], suffix, ' ', config.time].join('')
}

const FixedScheduleEditor: FC<{
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}> = ({ value, onChange, disabled }) => {
  const { t } = useTranslation()
  const parsed = parseFixedCron(value)
  const [config, setConfig] = useState<FixedScheduleConfig>(parsed ?? DEFAULT_FIXED_SCHEDULE)

  useEffect(() => {
    const nextConfig = parseFixedCron(value)
    if (nextConfig) setConfig(nextConfig)
  }, [value])

  const frequencyOptions = [
    { value: 'daily', label: t('agent.cherryClaw.tasks.fixedSchedule.daily', '每天') },
    { value: 'weekdays', label: t('agent.cherryClaw.tasks.fixedSchedule.weekdays', '工作日（周一至周五）') },
    { value: 'weekly', label: t('agent.cherryClaw.tasks.fixedSchedule.weekly', '每周') },
    { value: 'monthly', label: t('agent.cherryClaw.tasks.fixedSchedule.monthly', '每月') }
  ]
  const weekdayOptions = getWeekdayOptions(t)
  const dayOfMonthOptions = getDayOfMonthOptions(t)

  const updateConfig = (updates: Partial<FixedScheduleConfig>) => {
    const nextConfig = { ...config, ...updates }
    setConfig(nextConfig)
    onChange(buildFixedCron(nextConfig))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 gap-2">
        <Select
          size="small"
          className="min-w-0 flex-1"
          value={config.frequency}
          options={frequencyOptions}
          disabled={disabled}
          onChange={(frequency: FixedScheduleFrequency) => updateConfig({ frequency })}
        />
        <TimePicker
          size="small"
          className="w-24 shrink-0"
          format="HH:mm"
          minuteStep={5}
          value={toTimeValue(config.time)}
          disabled={disabled}
          allowClear={false}
          onChange={(time) => time && updateConfig({ time: time.format('HH:mm') })}
        />
      </div>
      {config.frequency === 'weekly' && (
        <Select
          size="small"
          value={config.weekday}
          options={weekdayOptions}
          disabled={disabled}
          onChange={(weekday) => updateConfig({ weekday })}
          placeholder={t('agent.cherryClaw.tasks.fixedSchedule.weekday', '选择星期')}
        />
      )}
      {config.frequency === 'monthly' && (
        <Select
          size="small"
          value={config.dayOfMonth}
          options={dayOfMonthOptions}
          disabled={disabled}
          onChange={(dayOfMonth) => updateConfig({ dayOfMonth })}
          placeholder={t('agent.cherryClaw.tasks.fixedSchedule.dayOfMonth', '选择日期')}
        />
      )}
      {value.trim() && !parsed && (
        <Alert
          type="info"
          showIcon
          message={t(
            'agent.cherryClaw.tasks.fixedSchedule.legacy',
            '当前任务使用旧版或复杂的固定时间规则。修改上方选项后，将转换为中文配置。'
          )}
          style={{ fontSize: 12 }}
        />
      )}
    </div>
  )
}

const TaskModelSelector: FC<{
  models: ApiModel[]
  value?: string | null
  fallbackModel?: string
  onChange: (value: string | null) => void
  disabled?: boolean
}> = ({ models, value, fallbackModel, onChange, disabled }) => {
  const { t } = useTranslation()
  const { enableDeveloperMode } = useEnableDeveloperMode()
  const modelPolicy = useAppSelector((state) => state.llm.modelPolicy)
  const selectedModelId = value ?? fallbackModel
  const options = getTaskModelOptions(models, selectedModelId, enableDeveloperMode, modelPolicy?.policy)

  return (
    <Select
      size="small"
      className="w-full min-w-0"
      value={selectedModelId || undefined}
      disabled={disabled}
      allowClear={enableDeveloperMode}
      placeholder={t('agent.cherryClaw.tasks.model.placeholder', '选择执行模型')}
      onChange={(nextValue) => onChange(nextValue ?? null)}
      options={options}
      notFoundContent={t('agent.cherryClaw.tasks.model.empty', '暂无可用的文本模型')}
    />
  )
}

// --------------- Shared channel selector with warnings ---------------

const TaskChannelSelector: FC<{
  channels: ChannelInfo[]
  channelIds: string[]
  onChange: (value: string[]) => void
  disabled?: boolean
}> = ({ channels, channelIds, onChange, disabled }) => {
  const { t } = useTranslation()

  if (channels.length === 0) return null

  const hasNoChatIds = channelIds.some((id) => !channels.find((c) => c.id === id)?.hasActiveChatIds)

  return (
    <>
      <SettingDivider />
      <SettingRow style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <SettingRowTitle>{t('agent.cherryClaw.tasks.channels.label')}</SettingRowTitle>
        <Select
          mode="multiple"
          size="small"
          className="w-full"
          value={channelIds}
          disabled={disabled}
          onChange={onChange}
          placeholder={t('agent.cherryClaw.tasks.channels.placeholder')}
          options={channels.map((ch) => ({
            value: ch.id,
            label: (
              <span className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${ch.isActive ? 'bg-green-500' : 'bg-gray-400'}`}
                />
                {ch.name}
              </span>
            )
          }))}
        />
        {hasNoChatIds && (
          <Alert
            type="warning"
            showIcon
            message={t('agent.cherryClaw.tasks.channels.noActiveChatIds')}
            className="mt-2"
            style={{ fontSize: 12 }}
          />
        )}
      </SettingRow>
    </>
  )
}

// --------------- Task Detail (right panel) ---------------

const TaskDetail: FC<{
  task: ScheduledTaskEntity
  agents: AgentInfo[]
  models: ApiModel[]
  channels: ChannelInfo[]
  onUpdate: (taskId: string, updates: UpdateTaskRequest) => Promise<void>
  onDelete: (taskId: string) => Promise<void>
  onRun: (taskId: string) => Promise<void>
  onToggleStatus: (taskId: string, newStatus: string) => Promise<void>
  onNavigateToSession?: () => void
  running?: boolean
}> = ({
  task,
  agents,
  models,
  channels,
  onUpdate,
  onDelete,
  onRun,
  onToggleStatus,
  onNavigateToSession,
  running = false
}) => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const compactGroupStyle = { marginBottom: 12, padding: 12 }

  const isCompleted = task.status === 'completed'
  const statusColors: Record<string, string> = { active: 'green', paused: 'orange', completed: 'blue' }
  const statusLabels: Record<string, string> = {
    active: t('agent.cherryClaw.tasks.status.active'),
    paused: t('agent.cherryClaw.tasks.status.paused'),
    completed: t('agent.cherryClaw.tasks.status.completed')
  }
  const scheduleTypeLabels: Record<string, string> = {
    cron: t('agent.cherryClaw.tasks.scheduleType.cron'),
    interval: t('agent.cherryClaw.tasks.scheduleType.interval'),
    once: t('agent.cherryClaw.tasks.scheduleType.once')
  }
  const agent = agents.find((a) => a.id === task.agent_id)
  const agentName = agent?.name ?? task.agent_id
  const effectiveModelId = task.model_id ?? agent?.model
  const selectedModel = models.find((model) => model.id === effectiveModelId)
  const modelName = selectedModel
    ? getTaskModelLabel(selectedModel)
    : (effectiveModelId ?? t('agent.cherryClaw.tasks.model.followAgent', '跟随助手默认模型'))

  const [name, setName] = useState(task.name)
  const [prompt, setPrompt] = useState(task.prompt)
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [agentId, setAgentId] = useState(task.agent_id)
  const [modelId, setModelId] = useState(task.model_id ?? '')
  const [scheduleType, setScheduleType] = useState(task.schedule_type)
  const [scheduleValue, setScheduleValue] = useState(task.schedule_value)
  const [channelIds, setChannelIds] = useState<string[]>(task.channel_ids ?? [])
  const [repeatModalOpen, setRepeatModalOpen] = useState(false)
  const [repeatScheduleValue, setRepeatScheduleValue] = useState(buildFixedCron(DEFAULT_FIXED_SCHEDULE))

  useEffect(() => {
    setName(task.name)
    setPrompt(task.prompt)
    setAgentId(task.agent_id)
    setModelId(task.model_id ?? '')
    setScheduleType(task.schedule_type)
    setScheduleValue(task.schedule_value)
    setChannelIds(task.channel_ids ?? [])
  }, [task])

  const saveField = useCallback(
    (updates: UpdateTaskRequest) => {
      void onUpdate(task.id, updates)
    },
    [task.id, onUpdate]
  )

  const formatDateTime = (iso: string | null | undefined) => {
    if (!iso) return '-'
    const d = new Date(iso)
    const diff = Math.abs(Date.now() - d.getTime())
    if (diff < 86400_000) {
      return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    }
    return d.toLocaleString(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  }

  const formatScheduleValue = () => {
    if (task.schedule_type === 'cron') {
      const weekdayOptions = getWeekdayOptions(t)
      return describeFixedCron(
        task.schedule_value,
        {
          daily: t('agent.cherryClaw.tasks.fixedSchedule.daily', '每天'),
          weekdays: t('agent.cherryClaw.tasks.fixedSchedule.weekdaysShort', '工作日'),
          weekly: t('agent.cherryClaw.tasks.fixedSchedule.weekly', '每周'),
          monthly: t('agent.cherryClaw.tasks.fixedSchedule.monthly', '每月')
        },
        t('agent.cherryClaw.tasks.fixedSchedule.legacyShort', '自定义时间规则'),
        weekdayOptions,
        t('agent.cherryClaw.tasks.fixedSchedule.weekly', '每周'),
        t('agent.cherryClaw.tasks.fixedSchedule.monthlyValue', '每月 {{day}} 号')
      )
    }
    if (task.schedule_type === 'interval') return `${task.schedule_value} ${t('agent.cherryClaw.tasks.intervalUnit')}`
    if (task.schedule_type === 'once' && task.schedule_value) {
      return formatDateTime(task.schedule_value)
    }
    return task.schedule_value
  }

  return (
    <SettingContainer
      theme={theme}
      showScrollbar
      style={{
        flex: '0 0 auto',
        width: '100%',
        minHeight: '100%',
        minWidth: 0,
        overflow: 'visible',
        padding: '10px 14px'
      }}>
      {/* Header card */}
      <SettingGroup theme={theme} style={compactGroupStyle}>
        <SettingTitle>
          <div className="flex items-center gap-2">
            <Tag color={statusColors[task.status] ?? 'default'}>{statusLabels[task.status] ?? task.status}</Tag>
            <span className="text-(--color-text-3) text-xs">
              {agentName} · {modelName}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip
              title={
                isCompleted
                  ? t('agent.cherryClaw.tasks.runAgain', '再次执行')
                  : t('agent.cherryClaw.tasks.run', '立即执行')
              }>
              <Button
                size="small"
                icon={isCompleted ? <RotateCcw size={14} /> : <Play size={14} />}
                onClick={() => onRun(task.id)}
                loading={running}
                disabled={running}
              />
            </Tooltip>
            {task.schedule_type === 'once' && (
              <Tooltip title={t('agent.cherryClaw.tasks.convertToRecurring', '转为重复任务')}>
                <Button
                  size="small"
                  icon={<Repeat2 size={14} />}
                  onClick={() => {
                    setRepeatScheduleValue(buildFixedCron(DEFAULT_FIXED_SCHEDULE))
                    setRepeatModalOpen(true)
                  }}
                />
              </Tooltip>
            )}
            {!isCompleted && (
              <Tooltip
                title={
                  task.status === 'active'
                    ? t('agent.cherryClaw.tasks.pause', '暂停定时任务')
                    : t('agent.cherryClaw.tasks.resume', '恢复定时任务')
                }>
                <Button
                  size="small"
                  icon={task.status === 'active' ? <Pause size={14} /> : <CalendarClock size={14} />}
                  onClick={() => onToggleStatus(task.id, task.status === 'active' ? 'paused' : 'active')}
                />
              </Tooltip>
            )}
            <Popconfirm
              title={t('agent.cherryClaw.tasks.delete.confirm')}
              onConfirm={() => onDelete(task.id)}
              okText={t('agent.cherryClaw.tasks.delete.label')}
              cancelText={t('agent.cherryClaw.tasks.cancel')}>
              <Button size="small" danger icon={<Trash2 size={14} />} />
            </Popconfirm>
          </div>
        </SettingTitle>
        <SettingDivider />
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Tag color={scheduleTypeColors[task.schedule_type] ?? 'default'}>
            {scheduleTypeLabels[task.schedule_type] ?? task.schedule_type}
          </Tag>
          <span className="inline-flex items-center gap-1 text-(--color-text-3)">
            <Clock size={12} />
            {formatScheduleValue()}
          </span>
          {task.last_run && (
            <span className="inline-flex items-center gap-1 text-(--color-text-3)">
              <History size={12} />
              {t('agent.cherryClaw.tasks.lastRun')}: {formatDateTime(task.last_run)}
            </span>
          )}
          {task.next_run && (
            <span className="inline-flex items-center gap-1 text-(--color-text-3)">
              <CalendarClock size={12} />
              {t('agent.cherryClaw.tasks.nextRun')}: {formatDateTime(task.next_run)}
            </span>
          )}
        </div>
      </SettingGroup>

      {/* Editable fields card */}
      <SettingGroup theme={theme} style={compactGroupStyle}>
        <SettingTitle>{t('settings.general.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <SettingRowTitle>{t('agent.cherryClaw.tasks.name.label')}</SettingRowTitle>
          <Input
            size="small"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== task.name && saveField({ name: name.trim() })}
            disabled={isCompleted}
          />
        </SettingRow>
        <SettingDivider />
        {agents.length > 1 && (
          <>
            <SettingRow style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <SettingRowTitle>{t('agent.cherryClaw.channels.bindAgent')}</SettingRowTitle>
              <Select
                size="small"
                className="w-full"
                value={agentId}
                disabled={isCompleted}
                onChange={(value) => {
                  setAgentId(value)
                  saveField({ agent_id: value })
                }}
                options={agents.map((a) => ({ value: a.id, label: a.name }))}
              />
            </SettingRow>
            <SettingDivider />
          </>
        )}
        <SettingRow style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="flex items-center justify-between">
            <SettingRowTitle>{t('agent.cherryClaw.tasks.prompt.label')}</SettingRowTitle>
            {!isCompleted && (
              <Tooltip title={t('agent.cherryClaw.tasks.prompt.expand')}>
                <Button
                  type="text"
                  size="small"
                  icon={<Maximize2 size={13} />}
                  onClick={() => setPromptModalOpen(true)}
                />
              </Tooltip>
            )}
          </div>
          <Input.TextArea
            size="small"
            autoSize={{ minRows: 2, maxRows: 4 }}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => prompt.trim() && prompt !== task.prompt && saveField({ prompt: prompt.trim() })}
            disabled={isCompleted}
          />
        </SettingRow>
        <SettingDivider />
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-4">
          <div className="min-w-0 lg:w-2/3 lg:max-w-[270px]">
            <SettingRowTitle>{t('agent.cherryClaw.tasks.model.label', '执行模型')}</SettingRowTitle>
            <TaskModelSelector
              models={models}
              value={modelId || null}
              fallbackModel={agents.find((a) => a.id === agentId)?.model}
              onChange={(value) => {
                setModelId(value ?? '')
                saveField({ model_id: value })
              }}
              disabled={isCompleted}
            />
          </div>
          <div className="min-w-0 lg:w-[150px] lg:shrink-0">
            <SettingRowTitle>{t('agent.cherryClaw.tasks.scheduleType.label')}</SettingRowTitle>
            <Select
              size="small"
              className="w-full"
              value={scheduleType}
              disabled={isCompleted}
              onChange={(value) => {
                const nextType = value
                setScheduleType(nextType)
                setScheduleValue(nextType === 'cron' ? buildFixedCron(DEFAULT_FIXED_SCHEDULE) : '')
              }}
              options={[
                {
                  value: 'cron',
                  label: (
                    <span className="inline-flex items-center gap-1">
                      {t('agent.cherryClaw.tasks.scheduleType.cron')} <ScheduleTypeHelp type="cron" />
                    </span>
                  )
                },
                {
                  value: 'interval',
                  label: (
                    <span className="inline-flex items-center gap-1">
                      {t('agent.cherryClaw.tasks.scheduleType.interval')} <ScheduleTypeHelp type="interval" />
                    </span>
                  )
                },
                {
                  value: 'once',
                  label: (
                    <span className="inline-flex items-center gap-1">
                      {t('agent.cherryClaw.tasks.scheduleType.once')} <ScheduleTypeHelp type="once" />
                    </span>
                  )
                }
              ]}
            />
          </div>
          <div className="min-w-0 lg:w-[240px] lg:shrink-0">
            <SettingRowTitle>{t('agent.cherryClaw.tasks.scheduleValue')}</SettingRowTitle>
            {scheduleType === 'cron' && (
              <FixedScheduleEditor
                value={scheduleValue}
                disabled={isCompleted}
                onChange={(value) => {
                  setScheduleValue(value)
                  saveField({ schedule_type: 'cron', schedule_value: value })
                }}
              />
            )}
            {scheduleType === 'interval' && (
              <Input
                size="small"
                type="number"
                min={1}
                value={scheduleValue}
                onChange={(e) => setScheduleValue(e.target.value)}
                onBlur={() =>
                  scheduleValue.trim() &&
                  scheduleValue !== task.schedule_value &&
                  saveField({ schedule_type: scheduleType, schedule_value: scheduleValue.trim() })
                }
                placeholder={t('agent.cherryClaw.tasks.intervalPlaceholder')}
                suffix={t('agent.cherryClaw.tasks.intervalUnit')}
                disabled={isCompleted}
              />
            )}
            {scheduleType === 'once' && (
              <DatePicker
                size="small"
                showTime
                className="w-full"
                value={scheduleValue ? dayjs(scheduleValue) : null}
                disabledDate={(current) => current.isBefore(dayjs(), 'day')}
                disabledTime={getDisabledScheduleTime}
                onChange={(val) => {
                  if (val) {
                    const iso = val.toISOString()
                    setScheduleValue(iso)
                    saveField({ schedule_type: scheduleType, schedule_value: iso })
                  }
                }}
                disabled={isCompleted}
              />
            )}
          </div>
        </div>
        <TaskChannelSelector
          channels={channels}
          channelIds={channelIds}
          onChange={(value) => {
            setChannelIds(value)
            saveField({ channel_ids: value })
          }}
          disabled={isCompleted}
        />
      </SettingGroup>

      {/* Keep execution history below the editable settings so it can grow without hiding controls. */}
      <SettingGroup theme={theme} style={compactGroupStyle}>
        <SettingTitle>{t('agent.cherryClaw.tasks.logs.label')}</SettingTitle>
        <SettingDivider />
        <TaskLogsInline
          taskId={task.id}
          agentId={task.agent_id}
          models={models}
          onNavigateToSession={onNavigateToSession}
        />
      </SettingGroup>

      <Modal
        title={t('agent.cherryClaw.tasks.prompt.label')}
        open={promptModalOpen}
        onCancel={() => {
          if (prompt.trim() && prompt !== task.prompt) {
            saveField({ prompt: prompt.trim() })
          }
          setPromptModalOpen(false)
        }}
        footer={null}
        width={640}
        styles={{
          body: {
            maxHeight: 'min(70vh, 560px)',
            overflowY: 'auto',
            paddingRight: 8
          }
        }}>
        <Input.TextArea
          autoSize={{ minRows: 12, maxRows: 30 }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={isCompleted}
          style={{ marginTop: 8 }}
        />
      </Modal>

      <Modal
        title={t('agent.cherryClaw.tasks.convertToRecurring', '转为重复任务')}
        open={repeatModalOpen}
        okText={t('common.confirm', '确认')}
        cancelText={t('common.cancel', '取消')}
        onCancel={() => setRepeatModalOpen(false)}
        onOk={async () => {
          await onUpdate(task.id, {
            schedule_type: 'cron',
            schedule_value: repeatScheduleValue,
            status: 'active'
          })
          setRepeatModalOpen(false)
        }}>
        <div className="flex flex-col gap-2">
          <span className="text-(--color-text-3) text-xs">
            {t(
              'agent.cherryClaw.tasks.convertToRecurringHint',
              '选择后，该任务会保留现有执行记录，并从下一次计划时间开始重复执行。'
            )}
          </span>
          <FixedScheduleEditor value={repeatScheduleValue} onChange={setRepeatScheduleValue} />
        </div>
      </Modal>
    </SettingContainer>
  )
}

// --------------- Inline Logs ---------------

const TaskLogsInline: FC<{
  taskId: string
  agentId: string
  models: ApiModel[]
  onNavigateToSession?: () => void
}> = ({ taskId, agentId, models, onNavigateToSession }) => {
  // Keep the history area predictable: one compact row is roughly 36px, so
  // the table shows about 20 runs before scrolling internally.
  const LOG_TABLE_BODY_HEIGHT = 20 * 36
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { logs, isLoading } = useTaskLogs(taskId)
  const [searchText, setSearchText] = useState('')
  const [selectedLog, setSelectedLog] = useState<TaskRunLogEntity | null>(null)

  const filteredLogs = useMemo(() => {
    if (!searchText.trim()) return logs
    const query = searchText.toLowerCase()
    return logs.filter(
      (log) =>
        log.result?.toLowerCase().includes(query) ||
        log.error?.toLowerCase().includes(query) ||
        log.status.toLowerCase().includes(query) ||
        new Date(log.run_at).toLocaleString(locale).toLowerCase().includes(query)
    )
  }, [locale, logs, searchText])

  const navigateToSession = useCallback(
    (sessionId: string) => {
      dispatch(setActiveAgentId(agentId))
      dispatch(setActiveSessionIdAction({ agentId, sessionId }))
      onNavigateToSession?.()
      navigate('/agents')
    },
    [agentId, dispatch, navigate, onNavigateToSession]
  )

  const columns = [
    {
      title: t('agent.cherryClaw.tasks.logs.runAt'),
      dataIndex: 'run_at',
      key: 'run_at',
      width: 110,
      render: (val: string) =>
        new Date(val).toLocaleString(undefined, {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        })
    },
    {
      title: t('agent.cherryClaw.tasks.logs.duration'),
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 80,
      render: (val: number, record: TaskRunLogEntity) => {
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
      width: 70,
      render: (val: string) => {
        const color =
          val === 'success'
            ? 'green'
            : val === 'running'
              ? 'processing'
              : val === 'waiting_user' || val === 'paused'
                ? 'warning'
                : 'red'
        const logStatusLabels: Record<string, string> = {
          success: t('agent.cherryClaw.tasks.logs.success'),
          running: t('agent.cherryClaw.tasks.logs.running'),
          waiting_user: t('agent.cherryClaw.tasks.logs.waitingUser', 'Waiting for user'),
          paused: t('agent.cherryClaw.tasks.logs.paused', '已暂停'),
          stalled: t('agent.cherryClaw.tasks.logs.stalled', '疑似卡住'),
          error: t('agent.cherryClaw.tasks.logs.error')
        }
        return <Tag color={color}>{logStatusLabels[val] ?? val}</Tag>
      }
    },
    {
      title: t('agent.cherryClaw.tasks.logs.trigger', '触发方式'),
      dataIndex: 'trigger_type',
      key: 'trigger_type',
      width: 90,
      render: (val: string) => ({ scheduled: '定时', manual: '手动', retry: '重试' })[val] ?? val
    },
    {
      title: t('agent.cherryClaw.tasks.model.label', '模型'),
      dataIndex: 'model_id',
      key: 'model_id',
      width: 150,
      ellipsis: true,
      render: (val: string | null) => {
        if (!val) return t('agent.cherryClaw.tasks.model.followAgent', '跟随助手默认模型')
        const model = models.find((item) => item.id === val)
        return model?.name || model?.provider_model_id || val
      }
    },
    {
      title: t('agent.cherryClaw.tasks.logs.result'),
      dataIndex: 'result',
      key: 'result',
      ellipsis: true,
      render: (val: string | null, record: TaskRunLogEntity) => {
        const text =
          record.status === 'waiting_user'
            ? t('agent.cherryClaw.tasks.logs.waitingUserDesc', 'Waiting for browser handoff')
            : record.status === 'running'
              ? t('agent.cherryClaw.tasks.logs.running', 'Running...')
              : record.status === 'error' || record.status === 'stalled'
                ? record.error
                : (val ?? '-')
        const hasSession = !!record.session_id

        return (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={`block min-w-0 flex-1 cursor-pointer truncate text-left ${record.status === 'error' || record.status === 'stalled' ? 'text-red-500' : ''}`}
              onClick={() => setSelectedLog(record)}
              title={text ?? undefined}>
              {text}
            </button>
            {hasSession && (
              <Tooltip title={t('agent.cherryClaw.tasks.logs.viewSession', 'View session')}>
                <Button
                  type="text"
                  size="small"
                  icon={<ExternalLink size={12} />}
                  style={{ flexShrink: 0 }}
                  onClick={() => navigateToSession(record.session_id!)}
                />
              </Tooltip>
            )}
          </div>
        )
      }
    }
  ]

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spin size="small" />
      </div>
    )
  }

  if (logs.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('agent.cherryClaw.tasks.logs.empty')} />
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        size="small"
        prefix={<Search size={12} className="text-(--color-text-3)" />}
        placeholder={t('agent.cherryClaw.tasks.logs.search', 'Search logs...')}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        allowClear
      />
      <Table
        dataSource={filteredLogs}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={false}
        scroll={{ y: LOG_TABLE_BODY_HEIGHT }}
      />
      <Modal
        title={t('agent.cherryClaw.tasks.logs.detail', '执行详情')}
        open={selectedLog !== null}
        footer={null}
        onCancel={() => setSelectedLog(null)}>
        {selectedLog && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <Tag>
                {selectedLog.trigger_type === 'scheduled'
                  ? '定时'
                  : selectedLog.trigger_type === 'manual'
                    ? '手动'
                    : '重试'}
              </Tag>
              {selectedLog.model_id && (
                <Tag>
                  {(() => {
                    const model = models.find((item) => item.id === selectedLog.model_id)
                    return model?.name || model?.provider_model_id || selectedLog.model_id
                  })()}
                </Tag>
              )}
              {selectedLog.scheduled_for && (
                <Tag>
                  {t('agent.cherryClaw.tasks.logs.scheduledFor', '计划时间：{{time}}', {
                    time: new Date(selectedLog.scheduled_for).toLocaleString()
                  })}
                </Tag>
              )}
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-(--color-background-soft) p-3 text-xs">
              {selectedLog.error || selectedLog.result || '-'}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  )
}

// --------------- Schedule type config ---------------

const scheduleTypeColors: Record<string, string> = {
  cron: 'purple',
  interval: 'blue',
  once: 'orange'
}

const statusDotColors: Record<string, string> = {
  active: 'bg-green-500',
  paused: 'bg-yellow-500',
  completed: 'bg-blue-500'
}

// --------------- Create Form (right panel) ---------------

const CreateForm: FC<{
  agents: AgentInfo[]
  models: ApiModel[]
  channels: ChannelInfo[]
  onCancel: () => void
  onCreate: (agentId: string, req: CreateTaskRequest) => Promise<void>
}> = ({ agents, models, channels, onCancel, onCreate }) => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { enableDeveloperMode } = useEnableDeveloperMode()
  const modelPolicy = useAppSelector((state) => state.llm.modelPolicy)

  const [agentId, setAgentId] = useState<string | null>(agents.length === 1 ? agents[0].id : null)
  const [modelId, setModelId] = useState<string>(() =>
    getDefaultTaskModelId(
      models,
      agents.length === 1 ? agents[0].model : undefined,
      enableDeveloperMode,
      modelPolicy?.policy
    )
  )
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [scheduleType, setScheduleType] = useState<'cron' | 'interval' | 'once'>('cron')
  const [scheduleValue, setScheduleValue] = useState(() => buildFixedCron(DEFAULT_FIXED_SCHEDULE))
  const [channelIds, setChannelIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const isValid = agentId && modelId.trim() && name.trim() && prompt.trim() && scheduleValue.trim()

  useEffect(() => {
    const fallbackModel = agentId ? agents.find((agent) => agent.id === agentId)?.model : undefined
    const nextModelId = getDefaultTaskModelId(models, fallbackModel, enableDeveloperMode, modelPolicy?.policy)
    if (
      nextModelId &&
      (!modelId.trim() || !isAssistantModelIdentifierAllowed(modelId, enableDeveloperMode, modelPolicy?.policy))
    ) {
      setModelId(nextModelId)
    }
  }, [agentId, agents, enableDeveloperMode, modelId, modelPolicy?.policy, models])

  const handleCreate = useCallback(async () => {
    if (!agentId || !name.trim() || !prompt.trim() || !scheduleValue.trim()) return
    setSaving(true)
    try {
      await onCreate(agentId, {
        name: name.trim(),
        prompt: prompt.trim(),
        model_id: modelId.trim() || null,
        schedule_type: scheduleType,
        schedule_value: scheduleValue.trim(),
        channel_ids: channelIds.length > 0 ? channelIds : undefined
      })
    } finally {
      setSaving(false)
    }
  }, [agentId, modelId, name, prompt, scheduleType, scheduleValue, channelIds, onCreate])

  return (
    <SettingContainer
      theme={theme}
      showScrollbar
      style={{
        flex: '0 0 auto',
        width: '100%',
        minHeight: '100%',
        minWidth: 0,
        overflow: 'visible',
        padding: '10px 14px'
      }}>
      <SettingGroup theme={theme} style={{ marginBottom: 12, padding: 12 }}>
        <SettingTitle>{t('agent.cherryClaw.tasks.add')}</SettingTitle>
        <SettingDivider />

        {agents.length > 1 && (
          <>
            <SettingRow style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <SettingRowTitle>{t('agent.cherryClaw.channels.bindAgent')}</SettingRowTitle>
              <Select
                size="small"
                className="w-full"
                value={agentId}
                onChange={(value) => {
                  setAgentId(value)
                  setModelId(
                    getDefaultTaskModelId(
                      models,
                      agents.find((agent) => agent.id === value)?.model,
                      enableDeveloperMode,
                      modelPolicy?.policy
                    )
                  )
                }}
                placeholder={t('agent.cherryClaw.channels.selectAgent')}
                options={agents.map((a) => ({ value: a.id, label: a.name }))}
              />
            </SettingRow>
            <SettingDivider />
          </>
        )}

        <SettingRow style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <SettingRowTitle>{t('agent.cherryClaw.tasks.name.label')}</SettingRowTitle>
          <Input
            size="small"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('agent.cherryClaw.tasks.name.placeholder')}
          />
        </SettingRow>
        <SettingDivider />

        <SettingRow style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="flex items-center justify-between">
            <SettingRowTitle>{t('agent.cherryClaw.tasks.prompt.label')}</SettingRowTitle>
            <Tooltip title={t('agent.cherryClaw.tasks.prompt.expand')}>
              <Button
                type="text"
                size="small"
                icon={<Maximize2 size={13} />}
                onClick={() => setPromptModalOpen(true)}
              />
            </Tooltip>
          </div>
          <Input.TextArea
            size="small"
            autoSize={{ minRows: 2, maxRows: 4 }}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('agent.cherryClaw.tasks.prompt.placeholder')}
          />
        </SettingRow>
        <SettingDivider />

        <Modal
          title={t('agent.cherryClaw.tasks.prompt.label')}
          open={promptModalOpen}
          onCancel={() => setPromptModalOpen(false)}
          footer={null}
          width={640}
          styles={{
            body: {
              maxHeight: 'min(70vh, 560px)',
              overflowY: 'auto',
              paddingRight: 8
            }
          }}>
          <Input.TextArea
            autoSize={{ minRows: 12, maxRows: 30 }}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('agent.cherryClaw.tasks.prompt.placeholder')}
            style={{ marginTop: 8 }}
          />
        </Modal>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-4">
          <div className="min-w-0 lg:w-2/3 lg:max-w-[270px]">
            <SettingRowTitle>{t('agent.cherryClaw.tasks.model.label', '执行模型')}</SettingRowTitle>
            <TaskModelSelector
              models={models}
              value={modelId || null}
              fallbackModel={agentId ? agents.find((agent) => agent.id === agentId)?.model : undefined}
              onChange={(value) => setModelId(value ?? '')}
              disabled={!agentId}
            />
          </div>
          <div className="min-w-0 lg:w-[150px] lg:shrink-0">
            <SettingRowTitle>{t('agent.cherryClaw.tasks.scheduleType.label')}</SettingRowTitle>
            <Select
              size="small"
              className="w-full"
              value={scheduleType}
              onChange={(v) => {
                const nextType = v
                setScheduleType(nextType)
                setScheduleValue(nextType === 'cron' ? buildFixedCron(DEFAULT_FIXED_SCHEDULE) : '')
              }}
              options={[
                {
                  value: 'cron',
                  label: (
                    <span className="inline-flex items-center gap-1">
                      {t('agent.cherryClaw.tasks.scheduleType.cron')} <ScheduleTypeHelp type="cron" />
                    </span>
                  )
                },
                {
                  value: 'interval',
                  label: (
                    <span className="inline-flex items-center gap-1">
                      {t('agent.cherryClaw.tasks.scheduleType.interval')} <ScheduleTypeHelp type="interval" />
                    </span>
                  )
                },
                {
                  value: 'once',
                  label: (
                    <span className="inline-flex items-center gap-1">
                      {t('agent.cherryClaw.tasks.scheduleType.once')} <ScheduleTypeHelp type="once" />
                    </span>
                  )
                }
              ]}
            />
          </div>
          <div className="min-w-0 lg:w-[240px] lg:shrink-0">
            <SettingRowTitle>{t('agent.cherryClaw.tasks.scheduleValue')}</SettingRowTitle>
            {scheduleType === 'cron' && <FixedScheduleEditor value={scheduleValue} onChange={setScheduleValue} />}
            {scheduleType === 'interval' && (
              <Input
                size="small"
                type="number"
                min={1}
                value={scheduleValue}
                onChange={(e) => setScheduleValue(e.target.value)}
                placeholder={t('agent.cherryClaw.tasks.intervalPlaceholder')}
                suffix="min"
              />
            )}
            {scheduleType === 'once' && (
              <DatePicker
                size="small"
                showTime
                className="w-full"
                value={scheduleValue ? dayjs(scheduleValue) : null}
                disabledDate={(current) => current.isBefore(dayjs(), 'day')}
                disabledTime={getDisabledScheduleTime}
                onChange={(val) => {
                  if (val) {
                    setScheduleValue(val.toISOString())
                  }
                }}
              />
            )}
          </div>
        </div>
        <TaskChannelSelector channels={channels} channelIds={channelIds} onChange={setChannelIds} />
        <SettingDivider />

        <div className="flex gap-2">
          <Button size="small" onClick={onCancel}>
            {t('agent.cherryClaw.tasks.cancel')}
          </Button>
          <Button type="primary" size="small" disabled={!isValid} loading={saving} onClick={handleCreate}>
            {t('agent.cherryClaw.tasks.save')}
          </Button>
        </div>
      </SettingGroup>
    </SettingContainer>
  )
}

// --------------- Main component ---------------

type TasksSettingsProps = {
  embedded?: boolean
  onNavigateToSession?: () => void
}

const TasksSettings: FC<TasksSettingsProps> = ({ embedded = false, onNavigateToSession }) => {
  const { t } = useTranslation()
  const client = useAgentClient()
  const { models } = useApiModels()
  const { channels: rawChannels = [] } = useChannels()

  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [tasks, setTasks] = useState<ScheduledTaskEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set())

  const channels: ChannelInfo[] = useMemo(
    () =>
      rawChannels.map((ch: any) => ({
        id: ch.id,
        name: ch.name || ch.type,
        isActive: ch.is_active === true || ch.isActive === true,
        hasActiveChatIds:
          ((ch.config?.allowed_chat_ids as string[]) ?? []).length > 0 ||
          ((ch.config?.allowed_channel_ids as string[]) ?? []).length > 0 ||
          ((ch.active_chat_ids ?? ch.activeChatIds ?? []) as string[]).length > 0
      })),
    [rawChannels]
  )

  const loadData = useCallback(async () => {
    try {
      const [tasksRes, agentsRes] = await Promise.all([
        client.listTasks({ limit: 200 }),
        client.listAgents({ limit: 100 })
      ])
      setTasks(tasksRes.data)
      setAgents(
        agentsRes.data
          .filter((a) => {
            return a.configuration?.soul_enabled === true || a.configuration?.permission_mode === 'bypassPermissions'
          })
          .map((a) => ({ id: a.id, name: a.name ?? a.id, model: a.model }))
      )
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // Auto-select the first task when data is loaded and nothing is selected
  useEffect(() => {
    if (!loading && !selectedTaskId && !creating && tasks.length > 0) {
      setSelectedTaskId(tasks[0].id)
    }
  }, [loading, selectedTaskId, creating, tasks])

  const selectedTask = useMemo(() => tasks.find((t) => t.id === selectedTaskId) ?? null, [tasks, selectedTaskId])

  const getAgentName = useCallback((agentId: string) => agents.find((a) => a.id === agentId)?.name ?? agentId, [agents])
  const scheduleTypeLabelsMap: Record<string, string> = {
    cron: t('agent.cherryClaw.tasks.scheduleType.cron'),
    interval: t('agent.cherryClaw.tasks.scheduleType.interval'),
    once: t('agent.cherryClaw.tasks.scheduleType.once')
  }

  const handleStartCreate = useCallback(() => {
    setSelectedTaskId(null)
    setCreating(true)
  }, [])

  const handleCreate = useCallback(
    async (agentId: string, req: CreateTaskRequest) => {
      const created = await client.createTask(agentId, req)
      setCreating(false)
      await loadData()
      setSelectedTaskId(created.id)
    },
    [client, loadData]
  )

  const handleUpdate = useCallback(
    async (taskId: string, updates: UpdateTaskRequest) => {
      await client.updateTask(taskId, updates)
      void loadData()
    },
    [client, loadData]
  )

  const handleDelete = useCallback(
    async (taskId: string) => {
      await client.deleteTask(taskId)
      if (selectedTaskId === taskId) setSelectedTaskId(null)
      void loadData()
    },
    [client, selectedTaskId, loadData]
  )

  const handleRun = useCallback(
    async (taskId: string) => {
      if (runningTaskIds.has(taskId)) return
      setRunningTaskIds((current) => new Set(current).add(taskId))
      try {
        await client.runTask(taskId)
        window.toast.success({ key: 'run-task', title: t('agent.cherryClaw.tasks.runStarted', '任务已开始执行') })
        void loadData()
        // Refresh task logs SWR cache so the logs list updates
        const logsKey = client.taskPaths.logs(taskId)
        void mutate(logsKey)
        // Task runs asynchronously — refresh again after a delay to capture completion
        setTimeout(() => {
          void mutate(logsKey)
          void loadData()
        }, 1000)
      } catch (error) {
        window.toast.error(
          formatErrorMessageWithPrefix(error, t('agent.cherryClaw.tasks.error.runFailed', '定时任务执行失败'))
        )
      } finally {
        setRunningTaskIds((current) => {
          const next = new Set(current)
          next.delete(taskId)
          return next
        })
      }
    },
    [client, loadData, runningTaskIds, t]
  )

  const handleToggleStatus = useCallback(
    async (taskId: string, newStatus: string) => {
      await client.updateTask(taskId, { status: newStatus as 'active' | 'paused' })
      void loadData()
    },
    [client, loadData]
  )

  if (loading) {
    return (
      <div className="flex flex-1">
        <div className="flex flex-1 items-center justify-center">
          <Spin />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div
        className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-row overflow-hidden"
        style={{ height: embedded ? '100%' : 'calc(100vh - var(--navbar-height) - 6px)' }}>
        {/* Left panel: task list */}
        <Scrollbar
          className="flex shrink-0 flex-col gap-1.25 border-(--color-border) border-r-[0.5px] p-3 pb-12"
          style={{ width: 'var(--settings-width)', height: embedded ? '100%' : 'calc(100vh - var(--navbar-height))' }}>
          <div className="flex items-center justify-between">
            <SettingTitle>{t('settings.scheduledTasks.title')}</SettingTitle>
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              disabled={agents.length === 0}
              onClick={handleStartCreate}
            />
          </div>
          <div className="flex flex-col gap-1">
            {tasks.length === 0 && !creating ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <div className="flex flex-col gap-2">
                    <span>
                      {agents.length === 0
                        ? t('settings.scheduledTasks.noAgents')
                        : t('settings.scheduledTasks.noTasks')}
                    </span>
                    {agents.length === 0 && (
                      <span className="text-(--color-text-3) text-xs">{t('settings.scheduledTasks.noAgentsTip')}</span>
                    )}
                  </div>
                }
                style={{ marginTop: 20 }}
              />
            ) : (
              tasks.map((task) => (
                <ListItem
                  key={task.id}
                  active={selectedTaskId === task.id && !creating}
                  title={task.name}
                  subtitle={`${getAgentName(task.agent_id)} · ${scheduleTypeLabelsMap[task.schedule_type] ?? task.schedule_type}`}
                  icon={
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${statusDotColors[task.status] ?? 'bg-gray-400'}`}
                    />
                  }
                  onClick={() => {
                    setCreating(false)
                    setSelectedTaskId(task.id)
                  }}
                />
              ))
            )}
          </div>
        </Scrollbar>

        {/* Right panel */}
        <Scrollbar className="relative flex min-h-0 min-w-0 flex-1 flex-col" style={{ scrollbarGutter: 'stable' }}>
          {creating ? (
            <CreateForm
              agents={agents}
              models={models}
              channels={channels}
              onCancel={() => setCreating(false)}
              onCreate={handleCreate}
            />
          ) : selectedTask ? (
            <TaskDetail
              key={selectedTask.id}
              task={selectedTask}
              agents={agents}
              models={models}
              channels={channels}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
              onRun={handleRun}
              onToggleStatus={handleToggleStatus}
              onNavigateToSession={onNavigateToSession}
              running={runningTaskIds.has(selectedTask.id)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-(--color-text-3) text-sm">
              {tasks.length > 0
                ? t('settings.scheduledTasks.selectTask', 'Select a task to view details')
                : t('settings.scheduledTasks.noTasks')}
            </div>
          )}
        </Scrollbar>
      </div>
    </div>
  )
}

export default TasksSettings
