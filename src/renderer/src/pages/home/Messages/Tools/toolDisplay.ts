import type { MCPTool } from '@renderer/types'
import { t } from 'i18next'

import { AgentToolsType } from './MessageAgentTools/types'

export type ToolDisplayInfo = {
  label: string
  activeLabel: string
  doneLabel?: string
  description?: string
}

const normalize = (value?: string) => (value ?? '').toLowerCase().replace(/[_\s-]/g, '')

/** Inspect only tool envelopes, never arbitrary content retrieved from a page. */
export function getToolAvailability(response: unknown, depth = 0): 'search_limited' | 'handoff_timed_out' | undefined {
  if (depth > 2) return
  let value = response
  if (typeof value === 'string') {
    if (value.length > 64_000) return
    try {
      value = JSON.parse(value)
    } catch {
      return
    }
  }
  if (!value || typeof value !== 'object') return
  const result = value as Record<string, unknown>
  if (result.executed === false) {
    if (result.status === 'unavailable' && result.service === 'Crossref') return 'search_limited'
    if (result.status === 'unavailable' && result.service === 'Exa public MCP' && result.reason === 'rate_limit')
      return 'search_limited'
    if (result.status === 'timed_out' && result.service === 'Zen browser handoff') return 'handoff_timed_out'
  }
  if (Array.isArray(result.content)) {
    for (const item of result.content.slice(0, 8)) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        const availability = getToolAvailability(item.text, depth + 1)
        if (availability) return availability
      }
    }
  }
  return
}

/** Read the browser wrapper, not arbitrary text inside the retrieved article. */
export function isBrowserHandoffResponse(response: unknown): boolean {
  let value = response
  if (typeof value === 'string') {
    if (value.length > 64_000) return false
    try {
      value = JSON.parse(value)
    } catch {
      return false
    }
  }
  if (!value || typeof value !== 'object') return false
  const result = value as { tabId?: unknown; userAction?: { reason?: unknown }; content?: unknown }
  if (typeof result.tabId === 'string' && typeof result.userAction?.reason === 'string') return true
  if (Array.isArray(result.content)) {
    return result.content.slice(0, 8).some((item) => {
      if (!item || typeof item !== 'object' || item.type !== 'text' || typeof item.text !== 'string') return false
      // MCP transports can wrap the serialized browser result in text blocks.
      try {
        const parsed = JSON.parse(item.text)
        return typeof parsed?.tabId === 'string' && typeof parsed?.userAction?.reason === 'string'
      } catch {
        return false
      }
    })
  }
  return false
}

const getMcpParts = (toolName: string) => {
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  const parts = toolName.slice(5).split('__')
  return {
    serverName: parts[0] ?? '',
    name: parts.slice(1).join('__')
  }
}

export const getToolDisplayInfo = (toolName?: string, tool?: Pick<MCPTool, 'serverName' | 'name'>): ToolDisplayInfo => {
  const mcpParts = getMcpParts(toolName ?? '')
  const serverName = tool?.serverName ?? mcpParts?.serverName ?? ''
  const name = tool?.name ?? mcpParts?.name ?? toolName ?? 'Tool'
  const normalizedServer = normalize(serverName)
  const normalizedName = normalize(name)
  if (normalizedName === 'readpaper') {
    return {
      label: t('message.tools.read_paper.label'),
      activeLabel: t('message.tools.read_paper.active'),
      doneLabel: t('message.tools.read_paper.done')
    }
  }

  if (normalizedServer.includes('browser')) {
    if (normalizedName.includes('waitforuser')) {
      return {
        label: '等待网页接管',
        activeLabel: '等待你接管网页',
        doneLabel: '接管完成',
        description: '请在打开的浏览器窗口中完成登录、验证或确认'
      }
    }

    if (normalizedName.includes('open') || normalizedName.includes('navigate')) {
      return {
        label: '打开网页',
        activeLabel: '正在打开网页',
        doneLabel: '网页已打开',
        description: '智能助手正在准备网页内容'
      }
    }

    if (normalizedName.includes('snapshot') || normalizedName.includes('screenshot')) {
      return {
        label: '读取网页',
        activeLabel: '正在读取网页',
        doneLabel: '网页读取完成',
        description: '智能助手正在理解页面内容'
      }
    }

    if (normalizedName.includes('execute') || normalizedName.includes('click') || normalizedName.includes('type')) {
      return {
        label: '操作网页',
        activeLabel: '正在操作网页',
        doneLabel: '网页操作完成',
        description: '智能助手正在按任务要求处理页面'
      }
    }

    return {
      label: '浏览器操作',
      activeLabel: '正在处理网页',
      doneLabel: '网页处理完成'
    }
  }

  if (normalizedName.includes('search') || normalizedServer.includes('search')) {
    return {
      label: '搜索资料',
      activeLabel: '正在搜索资料',
      doneLabel: '搜索完成'
    }
  }

  switch (normalizedName === 'readwebpage' ? AgentToolsType.WebFetch : toolName) {
    case AgentToolsType.WebSearch:
      return { label: '搜索资料', activeLabel: '正在搜索资料', doneLabel: '搜索完成' }
    case AgentToolsType.WebFetch:
      return { label: '读取网页', activeLabel: '正在读取网页', doneLabel: '网页读取完成' }
    case AgentToolsType.Write:
      return { label: '写入文件', activeLabel: '正在写文件', doneLabel: '文件已写入' }
    case AgentToolsType.Edit:
    case AgentToolsType.MultiEdit:
    case AgentToolsType.NotebookEdit:
      return { label: '编辑文件', activeLabel: '正在编辑文件', doneLabel: '文件已更新' }
    case AgentToolsType.Read:
      return { label: '读取文件', activeLabel: '正在读取文件', doneLabel: '文件读取完成' }
    case AgentToolsType.Bash:
    case AgentToolsType.BashOutput:
      return { label: '执行操作', activeLabel: '正在执行操作', doneLabel: '操作完成' }
    case AgentToolsType.Task:
      return { label: '处理任务', activeLabel: '正在处理任务', doneLabel: '任务已完成' }
    case AgentToolsType.Glob:
    case AgentToolsType.Grep:
    case AgentToolsType.Search:
      return { label: '查找文件', activeLabel: '正在查找文件', doneLabel: '查找完成' }
    case AgentToolsType.TodoWrite:
      return { label: '整理任务清单', activeLabel: '正在整理任务清单', doneLabel: '任务清单已更新' }
    case AgentToolsType.Skill:
      return { label: '使用技能', activeLabel: '正在使用技能', doneLabel: '技能执行完成' }
    default:
      return { label: name, activeLabel: '正在处理', doneLabel: '已完成' }
  }
}

export const getToolStatusLabel = (
  status: string | undefined,
  displayInfo: ToolDisplayInfo,
  hasError = false
): string | undefined => {
  switch (status) {
    case 'streaming':
    case 'pending':
    case 'invoking':
      return displayInfo.activeLabel
    case 'waiting':
      return displayInfo.activeLabel || '等待确认'
    case 'done':
      return hasError ? '处理失败' : displayInfo.doneLabel || '已完成'
    case 'cancelled':
      return '已取消'
    case 'error':
      return '处理失败'
    default:
      return undefined
  }
}
