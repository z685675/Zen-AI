import type { HotpatchStatus } from '@shared/hotpatch'
import { Button, Flex, Input, Popconfirm, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function HotpatchSettings() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<HotpatchStatus>()
  const [busy, setBusy] = useState(false)
  const [testCode, setTestCode] = useState('')
  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void window.api.hotpatch
        .status()
        .then((value) => {
          if (mounted) setStatus(value)
        })
        .catch(() => {})
    }
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [])
  const action = async (kind: 'check' | 'disable' | 'enable') => {
    setBusy(true)
    try {
      setStatus(
        kind === 'check'
          ? await window.api.hotpatch.check(testCode.trim() || undefined)
          : await window.api.hotpatch[kind]()
      )
    } catch {
      window.toast.error(t('hotpatch.requestFailed'))
    } finally {
      setBusy(false)
    }
  }
  if (!status) return null
  const labels: Record<HotpatchStatus['status'], string> = {
    unavailable: t('hotpatch.status.unavailable'),
    builtin: t('hotpatch.status.builtin'),
    active: t('hotpatch.status.active'),
    checking: t('hotpatch.status.checking'),
    pending: t('hotpatch.status.pending'),
    recovering: t('hotpatch.status.recovering'),
    disabled: t('hotpatch.status.disabled')
  }
  return (
    <Flex vertical gap={10}>
      <Flex align="center" justify="space-between" gap={12} wrap>
        <Typography.Text>
          {t('hotpatch.title')} <Tag>{labels[status.status]}</Tag> {status.patchId && <Tag>{status.patchId}</Tag>}
        </Typography.Text>
        <Flex gap={8}>
          <Button
            loading={busy}
            disabled={!status.enabled || status.status === 'disabled'}
            onClick={() => void action('check')}>
            {t('hotpatch.check')}
          </Button>
          {status.status === 'disabled' ? (
            <Button disabled={!status.enabled || busy} onClick={() => void action('enable')}>
              {t('hotpatch.enable')}
            </Button>
          ) : (
            <Popconfirm title={t('hotpatch.disableConfirm')} onConfirm={() => action('disable')}>
              <Button disabled={!status.enabled || busy}>{t('hotpatch.disable')}</Button>
            </Popconfirm>
          )}
        </Flex>
      </Flex>
      <Typography.Text type="secondary">{t('hotpatch.description')}</Typography.Text>
      {status.enabled && (
        <Input.Password
          aria-label={t('hotpatch.testCode')}
          placeholder={t('hotpatch.testCode')}
          maxLength={256}
          value={testCode}
          onChange={(event) => setTestCode(event.target.value)}
          autoComplete="off"
        />
      )}
      {status.pendingPatchId && (
        <Typography.Text>{t('hotpatch.nextStartup', { patch: status.pendingPatchId })}</Typography.Text>
      )}
      {status.lastError && (
        <Typography.Text type="secondary">
          {t('hotpatch.safeFallback')} · {status.lastError.code}
        </Typography.Text>
      )}
    </Flex>
  )
}
