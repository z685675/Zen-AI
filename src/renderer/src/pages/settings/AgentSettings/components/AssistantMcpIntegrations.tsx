import { useMCPServers } from '@renderer/hooks/useMCPServers'
import type { GetAgentSessionResponse, MCPServer } from '@renderer/types'
import type { UpdateAgentSessionFunction } from '@renderer/types/agent'
import { DIFY_KNOWLEDGE_MCP, isAssistantMcpServer, OPENCODE_MCP_LIMIT } from '@shared/agents/opencodeMcp'
import { getOpenCodeAgentMode } from '@shared/agents/opencodeMode'
import { Alert, Button, List, Switch, Tag } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function AssistantMcpIntegrations({
  session,
  update,
  onManage
}: {
  session: GetAgentSessionResponse
  update: UpdateAgentSessionFunction
  onManage: () => void
}) {
  const { t } = useTranslation()
  const { mcpServers } = useMCPServers()
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState<string>()
  const [results, setResults] = useState<Record<string, { tools: string[] } | 'failed'>>({})
  const ids = session.configuration?.opencode_mcp_ids ?? []
  const servers = mcpServers.filter(isAssistantMcpServer)
  const readOnly = getOpenCodeAgentMode(session.configuration?.permission_mode) === 'plan'

  const toggle = async (id: string, enabled: boolean) => {
    setSaving(true)
    try {
      const selected = ids.filter((selected) => selected !== id && servers.some((server) => server.id === selected))
      await update({
        id: session.id,
        configuration: {
          ...session.configuration,
          permission_mode: session.configuration?.permission_mode ?? 'default',
          env_vars: session.configuration?.env_vars ?? {},
          max_turns: session.configuration?.max_turns ?? 100,
          opencode_mcp_ids: enabled ? [...selected, id] : selected
        }
      })
    } finally {
      setSaving(false)
    }
  }

  const check = async (server: MCPServer) => {
    setChecking(server.id)
    try {
      const tools = await window.api.agentLifecycle.probeMcp(server.id)
      setResults((state) => ({ ...state, [server.id]: { tools } }))
    } catch {
      setResults((state) => ({ ...state, [server.id]: 'failed' }))
    } finally {
      setChecking(undefined)
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-(--color-text-2) text-sm">{t('assistantMcpIntegrations.description')}</p>
      {readOnly && <Alert type="info" showIcon message={t('assistantMcpIntegrations.plan')} />}
      <Button className="self-start" onClick={onManage}>
        {t('assistantMcpIntegrations.manage')}
      </Button>
      {!servers.some((server) => server.type === 'inMemory' && server.name === DIFY_KNOWLEDGE_MCP) && (
        <p className="text-(--color-text-2) text-xs">{t('assistantMcpIntegrations.curated')}</p>
      )}
      <List<MCPServer>
        dataSource={servers}
        rowKey="id"
        locale={{ emptyText: t('assistantMcpIntegrations.empty') }}
        renderItem={(server) => {
          const selected = ids.includes(server.id)
          const status = results[server.id]
          return (
            <List.Item className="items-stretch! flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{server.name}</span>
                <Switch
                  aria-label={server.name}
                  checked={selected}
                  disabled={
                    saving ||
                    (!selected &&
                      (!server.isActive ||
                        ids.filter((id) => servers.some((item) => item.id === id)).length >= OPENCODE_MCP_LIMIT))
                  }
                  onChange={(enabled) => void toggle(server.id, enabled)}
                />
              </div>
              {server.description && <p className="text-(--color-text-2) text-xs">{server.description}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Tag color={status && status !== 'failed' && server.isActive ? 'success' : undefined}>
                  {t(
                    `assistantMcpIntegrations.${!server.isActive ? 'disabled' : status === 'failed' ? 'failed' : status ? 'connected' : 'unchecked'}`
                  )}
                </Tag>
                <Button
                  size="small"
                  loading={checking === server.id}
                  disabled={!server.isActive || !!checking}
                  onClick={() => void check(server)}>
                  {t('assistantMcpIntegrations.test')}
                </Button>
              </div>
              {status && status !== 'failed' && (
                <p className="break-words text-(--color-text-2) text-xs">
                  {status.tools.join(' · ') || t('assistantMcpIntegrations.noTools')}
                </p>
              )}
            </List.Item>
          )
        }}
      />
    </div>
  )
}
