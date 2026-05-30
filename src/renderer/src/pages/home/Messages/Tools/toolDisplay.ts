import type { MCPTool } from '@renderer/types'

import { AgentToolsType } from './MessageAgentTools/types'

export type ToolDisplayInfo = {
  label: string
  activeLabel: string
  doneLabel?: string
  description?: string
}

const normalize = (value?: string) => (value ?? '').toLowerCase().replace(/[_\s-]/g, '')

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

  switch (toolName) {
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
