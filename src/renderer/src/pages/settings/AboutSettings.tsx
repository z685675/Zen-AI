import { HStack } from '@renderer/components/Layout'
import { APP_NAME, AppLogo } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import { runAsyncFunction } from '@renderer/utils'
import {
  APP_DOWNLOADS_URL,
  APP_FEEDBACK_URL,
  APP_RELEASES_URL,
  APP_SUPPORT_EMAIL,
  APP_WEBSITE_URL
} from '@shared/config/constant'
import { Avatar, Button, Row, Tag } from 'antd'
import { Bug, Download, Globe, Mail } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingContainer, SettingDivider, SettingGroup, SettingRow, SettingTitle } from '.'

const AboutSettings: FC = () => {
  const [version, setVersion] = useState('')
  const [isPortable, setIsPortable] = useState(false)
  const { t } = useTranslation()
  const { theme } = useTheme()

  const onOpenWebsite = (url: string) => {
    void window.api.openWebsite(url)
  }

  useEffect(() => {
    void runAsyncFunction(async () => {
      const appInfo = await window.api.getAppInfo()
      setVersion(appInfo.version)
      setIsPortable(appInfo.isPortable)
    })
  }, [])

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.about.title')}</SettingTitle>
        <SettingDivider />
        <AboutHeader>
          <Row align="middle">
            <AvatarWrapper onClick={() => onOpenWebsite(APP_WEBSITE_URL)}>
              <Avatar src={AppLogo} size={80} style={{ minHeight: 80 }} />
            </AvatarWrapper>
            <VersionWrapper>
              <Title>{APP_NAME}</Title>
              <Description>{t('settings.about.description')}</Description>
              <HStack alignItems="center" gap={8}>
                <Tag onClick={() => onOpenWebsite(APP_RELEASES_URL)} color="cyan" style={{ marginTop: 8, cursor: 'pointer' }}>
                  v{version}
                </Tag>
                {isPortable && (
                  <Tag color="gold" style={{ marginTop: 8 }}>
                    Portable
                  </Tag>
                )}
              </HStack>
            </VersionWrapper>
          </Row>
        </AboutHeader>
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingRow>
          <SettingRowTitle>
            <Download size={18} />
            下载最新软件包
          </SettingRowTitle>
          <Button onClick={() => onOpenWebsite(APP_DOWNLOADS_URL)}>{t('settings.about.releases.button')}</Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <Globe size={18} />
            {t('settings.about.website.title')}
          </SettingRowTitle>
          <Button onClick={() => onOpenWebsite(APP_WEBSITE_URL)}>{t('settings.about.website.button')}</Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <Bug size={18} />
            {t('settings.about.feedback.title')}
          </SettingRowTitle>
          <Button onClick={() => onOpenWebsite(APP_FEEDBACK_URL)}>{t('settings.about.feedback.button')}</Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <Mail size={18} />
            {t('settings.about.contact.title')}
          </SettingRowTitle>
          <ContactEmail>{APP_SUPPORT_EMAIL}</ContactEmail>
        </SettingRow>
      </SettingGroup>
    </SettingContainer>
  )
}

const AboutHeader = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 0;
`

const VersionWrapper = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 80px;
  justify-content: center;
  align-items: flex-start;
`

const Title = styled.div`
  font-size: 20px;
  font-weight: bold;
  color: var(--color-text-1);
  margin-bottom: 5px;
`

const Description = styled.div`
  font-size: 14px;
  color: var(--color-text-2);
  text-align: center;
`

const AvatarWrapper = styled.div`
  position: relative;
  cursor: pointer;
  margin-right: 15px;
`

export const SettingRowTitle = styled.div`
  font-size: 14px;
  line-height: 18px;
  color: var(--color-text-1);
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
`

const ContactEmail = styled.div`
  font-size: 14px;
  color: var(--color-text-2);
  user-select: text;
`

export default AboutSettings
