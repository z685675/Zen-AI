import type { ThemeMode } from '@renderer/types'
import { Divider } from 'antd'
import Link from 'antd/es/typography/Link'
import type { CSSProp } from 'styled-components'
import styled from 'styled-components'

export const SettingContainer = styled.div<{ theme?: ThemeMode; showScrollbar?: boolean }>`
  display: flex;
  flex-direction: column;
  flex: 1;
  padding: 28px 36px 40px;
  overflow-y: auto;
  background: transparent;

  &::-webkit-scrollbar {
    display: ${(props) => (props.showScrollbar ? 'block' : 'none')};
    width: ${(props) => (props.showScrollbar ? '8px' : '0')};
  }

  &::-webkit-scrollbar-thumb {
    background: ${(props) => (props.showScrollbar ? 'var(--color-scrollbar-thumb)' : 'transparent')};
    border-radius: 4px;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: ${(props) => (props.showScrollbar ? 'var(--color-scrollbar-thumb-hover)' : 'transparent')};
  }
`

export const SettingTitle = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  user-select: none;
  font-size: 14px;
  font-weight: bold;
`

export const SettingSubtitle = styled.div`
  font-size: 14px;
  color: var(--color-text-1);
  margin: 15px 0 0 0;
  user-select: none;
  font-weight: bold;
`

export const SettingDescription = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  margin-top: 10px;
`

export const SettingDivider = styled(Divider)`
  margin: 14px 0;
  border-block-start: 0.5px solid var(--color-border);
`

export const SettingRow = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  min-height: 32px;
`

export const SettingRowTitle = styled.div`
  font-size: 14px;
  line-height: 18px;
  color: var(--color-text-1);
  display: flex;
  flex-direction: row;
  align-items: center;
`

export const SettingHelpTextRow = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 5px 0;
`

export const SettingHelpText = styled.div`
  font-size: 11px;
  color: var(--zen-text-3);
`

export const SettingHelpLink = styled(Link)`
  font-size: 11px;
  margin: 0 5px;
`

export const SettingGroup = styled.div<{ theme?: ThemeMode; css?: CSSProp }>`
  width: 100%;
  max-width: 860px;
  margin: 0 auto 22px;
  border-radius: var(--zen-radius-md);
  border: 0;
  padding: 20px 22px;
  background: var(--zen-glass-card);
  backdrop-filter: blur(24px) saturate(160%);
  box-shadow: var(--zen-shadow-card);
`
