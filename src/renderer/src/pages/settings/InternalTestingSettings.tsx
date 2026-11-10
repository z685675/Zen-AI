import { useTheme } from '@renderer/context/ThemeProvider'
import {
  publishDshPreviewStatus,
  refreshDshPreviewStatus,
  useDshPreviewStatus
} from '@renderer/services/DshPreviewService'
import { Alert, Button, Flex, Input, Modal, Spin } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { SettingDescription, SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '.'

const preparationLabels: Record<string, string> = {
  'downloading-node': 'settings.internalTesting.downloadingNode',
  'downloading-installer': 'settings.internalTesting.downloadingInstaller',
  'installing-runtime': 'settings.internalTesting.installingRuntime',
  verifying: 'settings.internalTesting.verifying'
}

export default function InternalTestingSettings() {
  const { theme } = useTheme()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const status = useDshPreviewStatus()
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState(false)
  const [busy, setBusy] = useState<'unlock' | 'prepare' | 'lock' | null>(null)
  const operation = useRef(0)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (busy !== 'prepare' && status?.state !== 'preparing') return
    const timer = setInterval(() => void refreshDshPreviewStatus().catch(() => {}), 1500)
    return () => clearInterval(timer)
  }, [busy, status?.state])

  const unlock = async () => {
    if (busy) return
    setBusy('unlock')
    setPasswordError(false)
    try {
      const result = await window.api.internalTesting.unlock(password)
      setPassword('')
      publishDshPreviewStatus(result.status)
      if (result.accepted) setPasswordOpen(false)
      else setPasswordError(true)
    } catch {
      setPasswordError(true)
    } finally {
      setBusy(null)
    }
  }

  const enter = async () => {
    if (busy) return
    const current = ++operation.current
    setBusy('prepare')
    setError(false)
    try {
      const prepared = await window.api.internalTesting.prepare()
      if (operation.current !== current) return
      publishDshPreviewStatus(prepared)
      if (prepared.unlocked && prepared.state === 'ready') navigate('/internal-assistant')
      else setError(true)
    } catch {
      if (operation.current === current) setError(true)
    } finally {
      if (operation.current === current) setBusy(null)
    }
  }

  const lock = async () => {
    ++operation.current
    setBusy('lock')
    try {
      publishDshPreviewStatus(await window.api.internalTesting.lock())
      setError(false)
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>{t('settings.internalTesting.title')}</SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.internalTesting.validation')}</SettingRowTitle>
        <Button
          onClick={() => {
            setPassword('')
            setPasswordError(false)
            setPasswordOpen(true)
          }}
          disabled={Boolean(busy) || Boolean(status?.unlocked)}>
          {t(status?.unlocked ? 'settings.internalTesting.unlocked' : 'settings.internalTesting.unlock')}
        </Button>
      </SettingRow>
      {status?.unlocked && (
        <>
          <SettingDescription>{t('settings.internalTesting.description')}</SettingDescription>
          <SettingDivider />
          <SettingRow>
            <SettingRowTitle>{t('settings.internalTesting.entry')}</SettingRowTitle>
            <Flex gap={8}>
              <Button onClick={lock} loading={busy === 'lock'} disabled={busy === 'lock'}>
                {t('settings.internalTesting.lock')}
              </Button>
              <Button
                type="primary"
                onClick={enter}
                disabled={Boolean(busy)}
                loading={busy === 'prepare' || status.state === 'preparing'}>
                {t('settings.internalTesting.enter')}
              </Button>
            </Flex>
          </SettingRow>
          {(busy === 'prepare' || status.state === 'preparing') && (
            <SettingDescription>
              <Flex align="center" gap={8}>
                <Spin size="small" />
                {t(preparationLabels[status.progress ?? ''] ?? 'settings.internalTesting.preparing')}
              </Flex>
            </SettingDescription>
          )}
          {(error || status.state === 'error') && (
            <Alert
              style={{ marginTop: 12 }}
              type="error"
              showIcon
              message={t('settings.internalTesting.prepareFailed')}
            />
          )}
        </>
      )}
      <Modal
        title={t('settings.internalTesting.validation')}
        open={passwordOpen}
        confirmLoading={busy === 'unlock'}
        okButtonProps={{ disabled: !password }}
        okText={t('settings.internalTesting.unlock')}
        cancelText={t('common.cancel')}
        onOk={unlock}
        onCancel={() => {
          if (busy) return
          setPassword('')
          setPasswordOpen(false)
        }}>
        <Input.Password
          autoFocus
          autoComplete="off"
          maxLength={128}
          value={password}
          disabled={Boolean(busy)}
          placeholder={t('settings.internalTesting.password')}
          onChange={(event) => {
            setPassword(event.target.value)
            setPasswordError(false)
          }}
          onPressEnter={() => {
            if (password) void unlock()
          }}
          status={passwordError ? 'error' : undefined}
        />
        {passwordError && (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            message={t('settings.internalTesting.passwordIncorrect')}
          />
        )}
      </Modal>
    </SettingGroup>
  )
}
