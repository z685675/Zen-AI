import { HStack } from '@renderer/components/Layout'
import { Collapse, Tag, Typography } from 'antd'
import type { PropsWithChildren } from 'react'
import { useTranslation } from 'react-i18next'

export default function ModelAdvancedSettings({ customized, children }: PropsWithChildren<{ customized: boolean }>) {
  const { t } = useTranslation()
  return (
    <Collapse
      ghost
      items={[
        {
          key: 'advanced',
          label: (
            <HStack alignItems="center" gap={8}>
              <span>{t('common.advanced_settings')}</span>
              <Tag color={customized ? 'gold' : undefined}>
                {t(customized ? 'chat.settings.parameters_customized' : 'chat.settings.parameters_default')}
              </Tag>
            </HStack>
          ),
          children: (
            <>
              <Typography.Paragraph type="secondary">{t('chat.settings.parameters_tip')}</Typography.Paragraph>
              {children}
            </>
          )
        }
      ]}
    />
  )
}
