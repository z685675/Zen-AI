import { HStack } from '@renderer/components/Layout'
import NavbarIcon from '@renderer/components/NavbarIcon'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useAppDispatch } from '@renderer/store'
import { setNarrowMode } from '@renderer/store/settings'
import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import SettingsButton from './SettingsButton'

const Tools = () => {
  const { t } = useTranslation()
  const { isTopNavbar } = useNavbarPosition()
  const { narrowMode } = useSettings()
  const dispatch = useAppDispatch()

  const handleNarrowModeToggle = async () => {
    await modelGenerating()
    dispatch(setNarrowMode(!narrowMode))
  }

  return (
    <HStack alignItems="center" gap={8}>
      <SettingsButton />
      {isTopNavbar && (
        <Tooltip title={t('navbar.expand')} mouseEnterDelay={0.8}>
          <NarrowIcon onClick={handleNarrowModeToggle}>
            <i className="iconfont icon-icon-adaptive-width"></i>
          </NarrowIcon>
        </Tooltip>
      )}
    </HStack>
  )
}

const NarrowIcon = styled(NavbarIcon)`
  @media (max-width: 1000px) {
    display: none;
  }
`

export default Tools
