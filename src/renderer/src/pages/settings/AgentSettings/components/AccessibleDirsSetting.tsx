import { loggerService } from '@logger'
import type { AgentBaseWithId, UpdateAgentBaseForm, UpdateAgentFunctionUnion } from '@renderer/types'
import { Button, Tag, Tooltip } from 'antd'
import { Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingsItem, SettingsTitle } from '../shared'

export interface AccessibleDirsSettingProps {
  base: AgentBaseWithId | undefined | null
  update: UpdateAgentFunctionUnion
}

const logger = loggerService.withContext('AccessibleDirsSetting')

export const AccessibleDirsSetting = ({ base, update }: AccessibleDirsSettingProps) => {
  const { t } = useTranslation()
  const [updatingPath, setUpdatingPath] = useState<string | null>(null)

  const updateAccessiblePaths = useCallback(
    async (accessible_paths: UpdateAgentBaseForm['accessible_paths'], path: string) => {
      if (!base || updatingPath) return false

      setUpdatingPath(path)
      try {
        return Boolean(await update({ id: base.id, accessible_paths }))
      } finally {
        setUpdatingPath(null)
      }
    },
    [base, update, updatingPath]
  )

  const addAccessiblePath = useCallback(async () => {
    if (!base) return

    try {
      const selected = await window.api.file.selectFolder()
      if (!selected) {
        return
      }

      if (base.accessible_paths.includes(selected)) {
        window.toast.warning(t('agent.session.accessible_paths.duplicate'))
        return
      }

      await updateAccessiblePaths([...base.accessible_paths, selected], selected)
    } catch (error) {
      logger.error('Failed to select accessible path:', error as Error)
      window.toast.error(t('agent.session.accessible_paths.select_failed'))
    }
  }, [base, t, updateAccessiblePaths])

  const removeAccessiblePath = useCallback(
    (path: string) => {
      if (!base) return
      const newPaths = base.accessible_paths.filter((p) => p !== path)
      void updateAccessiblePaths(newPaths, path)
    },
    [base, updateAccessiblePaths]
  )

  const setActiveAccessiblePath = useCallback(
    (targetPath: string) => {
      if (!base) return
      const reorderedPaths = [targetPath, ...base.accessible_paths.filter((path) => path !== targetPath)]
      void updateAccessiblePaths(reorderedPaths, targetPath)
    },
    [base, updateAccessiblePaths]
  )

  if (!base) return null

  return (
    <SettingsItem>
      <SettingsTitle
        contentAfter={
          <Tooltip title={t('agent.session.accessible_paths.add')}>
            <Button
              type="text"
              icon={<Plus size={16} />}
              shape="circle"
              disabled={updatingPath !== null}
              onClick={addAccessiblePath}
            />
          </Tooltip>
        }>
        {t('agent.session.accessible_paths.label')}
      </SettingsTitle>
      <ul className="flex flex-col">
        {base.accessible_paths.map((path, index) => (
          <li key={path} className="flex items-center justify-between gap-2 py-1">
            <span
              className="w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-text-2)] text-sm"
              title={path}>
              {path}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {index === 0 ? (
                <Tag color="blue" className="mr-0">
                  {t('agent.session.accessible_paths.current', '当前工作区')}
                </Tag>
              ) : (
                <Button
                  size="small"
                  type="text"
                  loading={updatingPath === path}
                  disabled={updatingPath !== null}
                  onClick={() => setActiveAccessiblePath(path)}>
                  {t('agent.session.accessible_paths.set_active', '设为当前')}
                </Button>
              )}
              <Tooltip
                title={
                  base.accessible_paths.length <= 1 ? t('agent.session.accessible_paths.error.at_least_one') : undefined
                }>
                <Button
                  size="small"
                  type="text"
                  danger
                  loading={updatingPath === path}
                  disabled={base.accessible_paths.length <= 1 || updatingPath !== null}
                  onClick={() => removeAccessiblePath(path)}>
                  {t('common.delete')}
                </Button>
              </Tooltip>
            </div>
          </li>
        ))}
      </ul>
    </SettingsItem>
  )
}
