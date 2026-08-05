type TaskErrorOperation = 'create' | 'list' | 'get' | 'update' | 'delete' | 'run' | 'logs'

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error ?? ''))

/** Convert scheduled-task failures into concise messages suitable for UI toasts. */
export const formatScheduledTaskError = (operation: TaskErrorOperation, error?: unknown): string => {
  const rawMessage = getErrorMessage(error)
  const message = rawMessage.toLowerCase()

  if (operation === 'run') {
    if (message.includes('already running')) return '任务正在执行中，请稍后再试'
    if (message.includes('task not found')) return '未找到对应的定时任务'
    if (message.includes('agent not found')) return '未找到对应的智能助手'
    if (message.includes('session not found') || message.includes('session was not created')) {
      return '任务会话创建失败，请检查智能助手、模型和工作区设置'
    }
    if (message.includes('timed out') || message.includes('timeout')) {
      return '任务执行超时，请检查任务内容或延长超时时间'
    }
    if (message.includes('abort') || message.includes('cancel')) return '任务被中断，本次执行未完成'
    return '任务执行失败，请检查模型配置、网络连接和工作区权限'
  }

  const labels: Record<TaskErrorOperation, string> = {
    create: '创建定时任务',
    list: '加载定时任务',
    get: '读取定时任务',
    update: '更新定时任务',
    delete: '删除定时任务',
    run: '执行任务',
    logs: '加载运行历史'
  }

  if (message.includes('not found')) return `${labels[operation]}失败，未找到对应的任务`
  if (message.includes('invalid') || message.includes('required') || message.includes('schedule')) {
    return `${labels[operation]}失败，定时任务配置无效`
  }
  return `${labels[operation]}失败，请稍后重试`
}
