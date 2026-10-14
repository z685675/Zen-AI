import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { exportErrorDiagnosticPackage, getDiagnosticAppInfo } from '@renderer/services/ErrorDiagnosticPackageService'
import { useAppSelector } from '@renderer/store'
import type { GetAgentSessionResponse } from '@renderer/types'
import { AssistantMessageStatus, type Message } from '@renderer/types/newMessage'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import type { SessionSkillInventory } from '@shared/agents/skillInventory'
import { Alert, Button, Dropdown, Modal, Spin, Table, Tag } from 'antd'
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { currentTurnSkillUsage } from './sessionSkillUsage'

export default function SessionInspectionMenu({ session }: { session: GetAgentSessionResponse }) {
  const { t } = useTranslation()
  const client = useAgentClient()
  const messages = useTopicMessages(buildAgentSessionTopicId(session.id))
  const blocks = useAppSelector((state) => state.messageBlocks.entities)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [inventory, setInventory] = useState<SessionSkillInventory>()
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)
  const exportLock = useRef(false)
  useEffect(() => {
    setOpen(false)
    setInventory(undefined)
    generation.current++
    const requestGeneration = generation
    return () => {
      requestGeneration.current++
    }
  }, [session.id])
  const inspect = async () => {
    const request = ++generation.current
    setOpen(true)
    setBusy(true)
    setFailed(false)
    setInventory(undefined)
    try {
      const value = await client.inspectSessionSkills(session.agent_id, session.id)
      if (request === generation.current) setInventory(value)
    } catch {
      if (request === generation.current) setFailed(true)
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  const exportSnapshot = () => {
    if (exportLock.current) return
    exportLock.current = true
    // Keep the chosen session/turn stable even if the user switches conversations.
    const lastUserIndex = messages.findLastIndex((item) => item.role === 'user')
    const message =
      messages.slice(lastUserIndex + 1).findLast((item) => item.role === 'assistant') ??
      ({
        id: `session-snapshot-${session.id}`,
        role: 'assistant',
        assistantId: session.agent_id,
        topicId: buildAgentSessionTopicId(session.id),
        createdAt: new Date().toISOString(),
        status: AssistantMessageStatus.PAUSED,
        blocks: []
      } satisfies Message)
    const relatedUserMessage = message.askId
      ? messages.find((item) => item.id === message.askId)
      : messages[lastUserIndex]
    const privacyNotice = t('agent.errorFallback.privacy_notice')
    window.modal.confirm({
      title: t('assistantPeripheral.exportTitle'),
      content: privacyNotice,
      okText: t('agent.errorFallback.export_package'),
      onCancel: () => {
        exportLock.current = false
      },
      onOk: async () => {
        setExporting(true)
        try {
          const saved = await exportErrorDiagnosticPackage({
            source: 'agent',
            title: t('assistantPeripheral.exportTitle'),
            description: t('assistantPeripheral.snapshotHint'),
            message,
            snapshotHasMessage: messages.some((item) => item.id === message.id),
            block: message.blocks.map((id) => blocks[id]).find((block) => block?.type === 'error'),
            error: message.blocks.map((id) => blocks[id]).find((block) => block?.type === 'error')?.error,
            relatedUserMessage,
            blockEntities: blocks,
            appInfo: await getDiagnosticAppInfo(),
            privacyNotice,
            sessionContext: { session, hasRecordedTurn: messages.length > 0, snapshotAt: new Date().toISOString() },
            sessionContextStatus: 'loaded-current-session-at-export-time'
          })
          if (saved) window.toast.success(t('assistantPeripheral.exportSaved'))
        } catch {
          window.toast.error(t('assistantPeripheral.exportFailed'))
        } finally {
          setExporting(false)
          exportLock.current = false
        }
      }
    })
  }
  const usage = currentTurnSkillUsage(messages, blocks)
  const bool = (value: boolean | null) =>
    t(value === null ? 'assistantPeripheral.unobserved' : value ? 'assistantPeripheral.yes' : 'assistantPeripheral.no')
  return (
    <>
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            { key: 'diagnostics', label: t('agent.errorFallback.export_package'), disabled: exporting },
            { key: 'skills', label: t('assistantPeripheral.skillsTitle') }
          ],
          onClick: ({ key }) => {
            if (key === 'skills') void inspect()
            else exportSnapshot()
          }
        }}>
        <Button
          type="text"
          loading={exporting}
          aria-label={t('assistantPeripheral.more')}
          icon={<MoreHorizontal size={17} />}
        />
      </Dropdown>
      <Modal
        open={open}
        title={t('assistantPeripheral.skillsTitle')}
        footer={null}
        width={820}
        onCancel={() => {
          generation.current++
          setBusy(false)
          setOpen(false)
        }}>
        <Alert type="info" showIcon message={t('assistantPeripheral.skillsHint')} />
        {busy && <Spin />}
        {failed && <Alert type="warning" message={t('assistantPeripheral.inventoryFailed')} />}
        {inventory && (
          <>
            <div className="my-3 text-xs">
              {t(
                {
                  observed: 'assistantPeripheral.native_observed',
                  'not-running': 'assistantPeripheral.native_not-running',
                  starting: 'assistantPeripheral.native_starting',
                  unavailable: 'assistantPeripheral.native_unavailable'
                }[inventory.nativeStatus]
              )}
            </div>
            {inventory.refreshRequired && <Alert type="warning" message={t('assistantPeripheral.staleSkills')} />}
            <Table
              size="small"
              dataSource={inventory.skills}
              rowKey={(row) => `${row.source}:${row.path}`}
              pagination={{ pageSize: 10 }}
              scroll={{ x: 700, y: 320 }}
              columns={[
                {
                  title: t('assistantPeripheral.name'),
                  dataIndex: 'name',
                  render: (name, row) => <span title={row.path}>{name}</span>
                },
                {
                  title: t('assistantPeripheral.source'),
                  dataIndex: 'source',
                  render: (source: SessionSkillInventory['skills'][number]['source']) =>
                    t(
                      {
                        installed: 'assistantPeripheral.source_installed',
                        workspace: 'assistantPeripheral.source_workspace',
                        native: 'assistantPeripheral.source_native'
                      }[source]
                    )
                },
                { title: t('assistantPeripheral.installed'), dataIndex: 'installed', render: bool },
                { title: t('assistantPeripheral.enabled'), dataIndex: 'enabled', render: bool },
                { title: t('assistantPeripheral.discovered'), dataIndex: 'discovered', render: bool }
              ]}
            />
          </>
        )}
        <div className="mt-3 text-xs">{t('assistantPeripheral.calledThisTurn')}</div>
        {usage.size ? (
          [...usage].map(([name, status]) => (
            <Tag key={name}>
              {name} ·{' '}
              {t(
                status === 'done' || status === 'success'
                  ? 'assistantPeripheral.callDone'
                  : status === 'error'
                    ? 'assistantPeripheral.callFailed'
                    : status === 'cancelled' || status === 'paused'
                      ? 'assistantPeripheral.callStopped'
                      : 'assistantPeripheral.callStarted'
              )}
            </Tag>
          ))
        ) : (
          <div className="my-2 text-(--color-text-3) text-xs">{t('assistantPeripheral.noCallEvidence')}</div>
        )}
      </Modal>
    </>
  )
}
