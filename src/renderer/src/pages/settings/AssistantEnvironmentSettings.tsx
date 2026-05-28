import { CheckCircleOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons'
import { useTheme } from '@renderer/context/ThemeProvider'
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

type DependencyId = 'bun' | 'uv' | 'uvx' | 'git' | 'pyodide'
type DependencySource = 'app' | 'system' | 'network' | 'missing' | 'error'

interface DependencyStatus {
  id: DependencyId
  installed: boolean
  source: DependencySource
  path?: string
  message?: string
}

interface AssistantEnvironmentCheckResult {
  bun: DependencyStatus
  uv: DependencyStatus
  uvx: DependencyStatus
  git: DependencyStatus
  pyodide: DependencyStatus
  binariesDir: string
  checkedAt: number
}

const CORE_DEPENDENCIES: DependencyId[] = ['bun', 'uv', 'uvx']
const OPTIONAL_DEPENDENCIES: DependencyId[] = ['git', 'pyodide']

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

    return (
      <DependencyCard key={dependency.id}>
        <DependencyMain>
          <DependencyHeader>
            <DependencyName>
              {dependency.installed ? <CheckCircleOutlined /> : <WarningOutlined />}
              {t(`settings.assistantEnvironment.dependencies.${dependency.id}.name`)}
            </DependencyName>
            <StatusTag color={dependency.installed ? 'success' : dependency.source === 'error' ? 'error' : 'warning'}>
              {dependency.installed
                ? t(`settings.assistantEnvironment.sources.${dependency.source}`)
                : t(
                    dependency.source === 'error'
                      ? 'settings.assistantEnvironment.status.error'
                      : 'settings.assistantEnvironment.status.missing'
                  )}
            </StatusTag>
          </DependencyHeader>
          <DependencyDescription>
            {t(`settings.assistantEnvironment.dependencies.${dependency.id}.description`)}
          </DependencyDescription>
          <DependencyPath>
            {dependency.path || dependency.message || t('settings.assistantEnvironment.noPath')}
          </DependencyPath>
        </DependencyMain>
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
