import { CheckCircleOutlined, ImportOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons'
import { isWin } from '@renderer/config/constant'
import { useTheme } from '@renderer/context/ThemeProvider'
import {
  ASSISTANT_DEPENDENCY_I18N_KEYS,
  ASSISTANT_DEPENDENCY_SOURCE_I18N_KEYS,
  type AssistantEnvironmentCheckResult,
  type DependencyId,
  type DependencyStatus
} from '@renderer/services/AssistantEnvironmentService'
import { Alert, Button, Spin, Tag } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import {
  SettingContainer,
  SettingDescription,
  SettingDivider,
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingTitle
} from '.'

const CORE_DEPENDENCIES: DependencyId[] = isWin ? ['bun', 'uv', 'uvx', 'git', 'python'] : ['bun', 'uv', 'uvx', 'python']
const OPTIONAL_DEPENDENCIES: DependencyId[] = isWin ? ['pyodide'] : ['git', 'pyodide']

const AssistantEnvironmentSettings: FC = () => {
  const { theme } = useTheme()
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<AssistantEnvironmentCheckResult | null>(null)

  const checkEnvironment = useCallback(async () => {
    try {
      setChecking(true)
      const nextResult = await window.api.checkAssistantEnvironment()
      setResult(nextResult)
    } catch (error: any) {
      window.toast.error(`${t('settings.assistantEnvironment.checkFailed')}: ${error.message}`)
    } finally {
      setChecking(false)
    }
  }, [t])

  useEffect(() => {
    void checkEnvironment()
  }, [checkEnvironment])

  const installBun = async () => {
    try {
      setInstalling(true)
      await window.api.installBunBinary()
      window.toast.success(t('settings.assistantEnvironment.installSuccess'))
      await checkEnvironment()
    } catch (error: any) {
      window.toast.error(`${t('settings.assistantEnvironment.installFailed')}: ${error.message}`)
    } finally {
      setInstalling(false)
    }
  }

  const installUv = async () => {
    try {
      setInstalling(true)
      await window.api.installUVBinary()
      window.toast.success(t('settings.assistantEnvironment.installSuccess'))
      await checkEnvironment()
    } catch (error: any) {
      window.toast.error(`${t('settings.assistantEnvironment.installFailed')}: ${error.message}`)
    } finally {
      setInstalling(false)
    }
  }

  const installPython = async () => {
    try {
      setInstalling(true)
      await window.api.installManagedPython()
      window.toast.success(t('settings.assistantEnvironment.installSuccess'))
      await checkEnvironment()
    } catch (error: any) {
      window.toast.error(`${t('settings.assistantEnvironment.installFailed')}: ${error.message}`)
    } finally {
      setInstalling(false)
    }
  }

  const importPython = async () => {
    try {
      setInstalling(true)
      const imported = await window.api.importManagedPython()
      if (!imported) return
      window.toast.success(t('settings.assistantEnvironment.importRuntimeSuccess'))
      await checkEnvironment()
    } catch (error: any) {
      window.toast.error(`${t('settings.assistantEnvironment.importRuntimeFailed')}: ${error.message}`)
    } finally {
      setInstalling(false)
    }
  }

  const confirmGitInstall = () =>
    new Promise<boolean>((resolve) => {
      window.modal.confirm({
        title: t('settings.assistantEnvironment.installGitConfirmTitle'),
        content: t('settings.assistantEnvironment.installGitConfirmContent'),
        okText: t('settings.assistantEnvironment.installGitAuto'),
        cancelText: t('common.cancel'),
        centered: true,
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })

  const installGit = async () => {
    const confirmed = await confirmGitInstall()
    if (!confirmed) {
      return false
    }

    try {
      setInstalling(true)
      await window.api.installGitForWindows()
      window.toast.success(t('settings.assistantEnvironment.installSuccess'))
      await checkEnvironment()
      return true
    } catch (error: any) {
      window.toast.error(`${t('settings.assistantEnvironment.installGitFailedFallback')}: ${error.message}`)
      void window.api.openWebsite('https://git-scm.com/download/win')
      return false
    } finally {
      setInstalling(false)
    }
  }

  const prepareCoreDependencies = async () => {
    if (!result) return

    try {
      setInstalling(true)

      if (!result.bun.installed) {
        await window.api.installBunBinary()
      }

      if (!result.uv.installed || !result.uvx.installed) {
        await window.api.installUVBinary()
      }

      if (!result.python.installed) {
        await window.api.installManagedPython()
      }

      if (isWin && !result.git.installed) {
        const gitInstalled = await installGit()
        if (!gitInstalled) {
          await checkEnvironment()
          return
        }
      }

      window.toast.success(t('settings.assistantEnvironment.prepareSuccess'))
      await checkEnvironment()
    } catch (error: any) {
      window.toast.error(`${t('settings.assistantEnvironment.installFailed')}: ${error.message}`)
    } finally {
      setInstalling(false)
    }
  }

  const renderDependency = (dependency: DependencyStatus) => {
    const needsInstall = !dependency.installed && (dependency.id === 'bun' || dependency.id === 'uv')
    const needsGitInstall = isWin && !dependency.installed && dependency.id === 'git'

    return (
      <DependencyCard key={dependency.id}>
        <DependencyMain>
          <DependencyHeader>
            <DependencyName>
              {dependency.installed ? <CheckCircleOutlined /> : <WarningOutlined />}
              {t(ASSISTANT_DEPENDENCY_I18N_KEYS[dependency.id].name)}
            </DependencyName>
            <StatusTag color={dependency.installed ? 'success' : dependency.source === 'error' ? 'error' : 'warning'}>
              {dependency.installed
                ? t(ASSISTANT_DEPENDENCY_SOURCE_I18N_KEYS[dependency.source])
                : t(
                    dependency.source === 'error'
                      ? 'settings.assistantEnvironment.status.error'
                      : 'settings.assistantEnvironment.status.missing'
                  )}
            </StatusTag>
          </DependencyHeader>
          <DependencyDescription>{t(ASSISTANT_DEPENDENCY_I18N_KEYS[dependency.id].description)}</DependencyDescription>
          <DependencyPath>
            {dependency.path || dependency.message || t('settings.assistantEnvironment.noPath')}
          </DependencyPath>
        </DependencyMain>
        {dependency.id === 'python' && (
          <DependencyActions>
            {!dependency.installed && (
              <Button size="small" type="primary" loading={installing} disabled={installing} onClick={installPython}>
                {t('settings.assistantEnvironment.install')}
              </Button>
            )}
            <Button size="small" icon={<ImportOutlined />} disabled={installing} onClick={importPython}>
              {t('settings.assistantEnvironment.importRuntime')}
            </Button>
          </DependencyActions>
        )}
        {needsInstall && (
          <Button
            size="small"
            type="primary"
            loading={installing}
            disabled={installing}
            onClick={dependency.id === 'bun' ? installBun : installUv}>
            {t('settings.assistantEnvironment.install')}
          </Button>
        )}
        {needsGitInstall && (
          <Button size="small" type="primary" loading={installing} disabled={installing} onClick={installGit}>
            {t('settings.assistantEnvironment.installGitAuto')}
          </Button>
        )}
      </DependencyCard>
    )
  }

  const missingCoreCount = result ? CORE_DEPENDENCIES.filter((id) => !result[id].installed).length : 0

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.assistantEnvironment.title')}</SettingTitle>
        <SettingDescription>{t('settings.assistantEnvironment.description')}</SettingDescription>
        <IntroAlert type="info" showIcon description={t('settings.assistantEnvironment.intro')} />
        <ActionRow>
          <Button icon={<ReloadOutlined />} onClick={checkEnvironment} loading={checking} disabled={installing}>
            {t('settings.assistantEnvironment.refresh')}
          </Button>
          <Button
            type="primary"
            onClick={prepareCoreDependencies}
            loading={installing}
            disabled={!result || missingCoreCount === 0}>
            {t('settings.assistantEnvironment.prepare')}
          </Button>
        </ActionRow>
        {result?.binariesDir && (
          <SettingDescription>
            {t('settings.assistantEnvironment.binariesDir')}: {result.binariesDir}
          </SettingDescription>
        )}
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingRow>
          <SettingRowTitle>{t('settings.assistantEnvironment.coreTitle')}</SettingRowTitle>
          {checking && <Spin size="small" />}
        </SettingRow>
        <SettingDescription>{t('settings.assistantEnvironment.coreDescription')}</SettingDescription>
        <SettingDivider />
        <DependencyList>
          {result ? CORE_DEPENDENCIES.map((id) => renderDependency(result[id])) : <Spin />}
        </DependencyList>
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingRow>
          <SettingRowTitle>{t('settings.assistantEnvironment.optionalTitle')}</SettingRowTitle>
        </SettingRow>
        <SettingDescription>{t('settings.assistantEnvironment.optionalDescription')}</SettingDescription>
        <SettingDivider />
        <DependencyList>
          {result ? OPTIONAL_DEPENDENCIES.map((id) => renderDependency(result[id])) : <Spin />}
        </DependencyList>
      </SettingGroup>
    </SettingContainer>
  )
}

const IntroAlert = styled(Alert)`
  margin-top: 14px;
  border-radius: var(--list-item-border-radius);
`

const ActionRow = styled.div`
  display: flex;
  flex-direction: row;
  gap: 10px;
  margin-top: 14px;
`

const DependencyList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const DependencyCard = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 0.5px solid var(--color-border);
  border-radius: var(--list-item-border-radius);
  background: var(--color-background-soft);
`

const DependencyMain = styled.div`
  min-width: 0;
`

const DependencyActions = styled.div`
  display: flex;
  flex: none;
  gap: 8px;
`

const DependencyHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const DependencyName = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-1);
  font-weight: 600;
`

const DependencyDescription = styled.div`
  margin-top: 6px;
  color: var(--color-text-2);
  font-size: 12px;
`

const DependencyPath = styled.div`
  margin-top: 6px;
  color: var(--color-text-3);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const StatusTag = styled(Tag)`
  margin-inline-end: 0;
`

export default AssistantEnvironmentSettings
