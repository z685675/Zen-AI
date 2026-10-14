import type { InstalledSkill, SkillCompatibilityReport } from '@types'
import { Alert, Button, Descriptions, Modal, Tag } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function SkillCompatibility({ skill }: { skill: InstalledSkill }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<SkillCompatibilityReport | null>(null)
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const requests = generation
    generation.current++
    setReport(null)
    setOpen(false)
    setBusy(false)
    return () => {
      requests.current++
    }
  }, [skill.id, skill.isEnabled])
  const inspect = async () => {
    const id = ++generation.current
    setOpen(true)
    setBusy(true)
    setFailed(false)
    setReport(null)
    try {
      const result = await window.api.skill.inspect(skill.id)
      if (id !== generation.current) return
      if (result.success) setReport(result.data)
      else setFailed(true)
    } catch {
      if (id === generation.current) setFailed(true)
    } finally {
      if (id === generation.current) setBusy(false)
    }
  }
  const list = (items: string[]) => (items.length ? items.join(', ') : t('assistantProduct.notDeclared'))
  return (
    <>
      <Button size="small" loading={busy} onClick={inspect}>
        {t('assistantProduct.inspectSkill')}
      </Button>
      <Modal
        title={t('assistantProduct.inspectSkill')}
        open={open}
        onCancel={() => {
          generation.current++
          setBusy(false)
          setOpen(false)
        }}
        footer={null}
        width={620}>
        <Alert type="info" showIcon message={t('assistantProduct.skillLimit')} />
        {failed && <Alert type="error" message={t('assistantProduct.inspectFailed')} />}
        {report && (
          <Descriptions column={1} size="small" bordered style={{ marginTop: 12 }}>
            <Descriptions.Item label={t('assistantProduct.definition')}>
              <Tag color={report.definitionValid ? 'green' : 'red'}>
                {t(report.definitionValid ? 'assistantProduct.definitionValid' : 'assistantProduct.definitionInvalid')}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('assistantProduct.enabled')}>
              {t(report.enabled ? 'assistantProduct.enabledHint' : 'assistantProduct.disabledHint')}
            </Descriptions.Item>
            <Descriptions.Item label={t('assistantProduct.compatibility')}>
              {report.compatibility ?? t('assistantProduct.notDeclared')}
            </Descriptions.Item>
            <Descriptions.Item label={t('assistantProduct.declaredTools')}>
              {list(report.declaredTools)}
            </Descriptions.Item>
            <Descriptions.Item label={t('assistantProduct.commands')}>
              {list(report.requiredCommands)}
            </Descriptions.Item>
            <Descriptions.Item label={t('assistantProduct.missingCommands')}>
              {report.missingCommands.length ? report.missingCommands.join(', ') : t('assistantProduct.noneFound')}
            </Descriptions.Item>
            {report.alternativeCommands.length > 0 && (
              <Descriptions.Item label={t('assistantProduct.alternatives')}>
                {report.alternativeCommands.join(', ')} —{' '}
                {t(report.alternativesAvailable ? 'assistantProduct.pathFound' : 'assistantProduct.pathMissing')}
              </Descriptions.Item>
            )}
            <Descriptions.Item label={t('assistantProduct.environment')}>
              {list(report.requiredEnvironment)}
            </Descriptions.Item>
            <Descriptions.Item label={t('assistantProduct.missingEnvironment')}>
              {report.missingEnvironment.length
                ? report.missingEnvironment.join(', ')
                : t('assistantProduct.noneFound')}
            </Descriptions.Item>
            <Descriptions.Item label={t('assistantProduct.conflicts')}>
              {report.conflicts.length
                ? report.conflicts.map((item) => `${item.name} / ${item.source} / ${item.folder}`).join('\n')
                : t('assistantProduct.noneFound')}
            </Descriptions.Item>
          </Descriptions>
        )}
        {report?.conflicts.length ? (
          <Alert type="warning" showIcon message={t('assistantProduct.conflictHint')} style={{ marginTop: 12 }} />
        ) : null}
      </Modal>
    </>
  )
}
