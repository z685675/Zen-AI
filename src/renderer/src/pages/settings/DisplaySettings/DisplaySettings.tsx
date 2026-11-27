import { ResetIcon } from '@renderer/components/Icons'
import TextBadge from '@renderer/components/TextBadge'
import { isLinux, isMac } from '@renderer/config/constant'
import {
  type SidebarEntryPlacement,
  uiSidebarPlacements,
  UNIFIED_SIDEBAR_ENTRIES
} from '@renderer/config/unifiedSidebar'
import { THEME_PRESET_ANTD_TOKENS } from '@renderer/context/AntdProvider'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useEnableDeveloperMode, useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import useUserTheme from '@renderer/hooks/useUserTheme'
import { UI_THEME_PRESETS } from '@renderer/services/UiThemePresetService'
import { useAppDispatch } from '@renderer/store'
import { setConversationFontSize } from '@renderer/store/settings'
import { ThemeMode } from '@renderer/types'
import { Button, Segmented, Select, Slider, Switch, Tooltip } from 'antd'
import { Minus, Plus } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingContainer, SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '..'

const DisplaySettings: FC = () => {
  const { windowStyle, setWindowStyle, conversationFontSize, userTheme, useSystemTitleBar, setUseSystemTitleBar } =
    useSettings()
  const { theme, settedTheme, setTheme, preset, setPreset } = useTheme()
  const { enableDeveloperMode } = useEnableDeveloperMode()
  const sidebarPlacements = useSyncExternalStore(uiSidebarPlacements.subscribe, uiSidebarPlacements.get)
  const sidebarEntries = useMemo(
    () => UNIFIED_SIDEBAR_ENTRIES.filter((entry) => !entry.developerOnly || enableDeveloperMode),
    [enableDeveloperMode]
  )
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const { setTimeoutTimer } = useTimer()
  const [currentZoom, setCurrentZoom] = useState(1.0)
  const { setUserTheme } = useUserTheme()

  const [fontList, setFontList] = useState<string[]>([])

  const handleWindowStyleChange = useCallback(
    (checked: boolean) => {
      setWindowStyle(checked ? 'transparent' : 'opaque')
    },
    [setWindowStyle]
  )

  const handleUseSystemTitleBarChange = (checked: boolean) => {
    window.modal.confirm({
      title: t('settings.use_system_title_bar.confirm.title'),
      content: t('settings.use_system_title_bar.confirm.content'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      centered: true,
      onOk() {
        setUseSystemTitleBar(checked)
        setTimeoutTimer(
          'handleUseSystemTitleBarChange',
          () => {
            void window.api.relaunchApp()
          },
          500
        )
      }
    })
  }

  useEffect(() => {
    // 初始化获取所有系统字体
    void window.api.getSystemFonts().then((fonts: string[]) => {
      setFontList(fonts)
    })

    // 初始化获取当前缩放值
    void window.api.handleZoomFactor(0).then((factor) => {
      setCurrentZoom(factor)
    })

    const handleResize = () => {
      void window.api.handleZoomFactor(0).then((factor) => {
        setCurrentZoom(factor)
      })
    }
    // 添加resize事件监听
    window.addEventListener('resize', handleResize)

    // 清理事件监听，防止内存泄漏
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  const handleZoomFactor = async (delta: number, reset: boolean = false) => {
    const zoomFactor = await window.api.handleZoomFactor(delta, reset)
    setCurrentZoom(zoomFactor)
  }

  const handleUserFontChange = useCallback(
    (value: string) => {
      setUserTheme({
        ...userTheme,
        userFontFamily: value
      })
    },
    [setUserTheme, userTheme]
  )

  const handleUserCodeFontChange = useCallback(
    (value: string) => {
      setUserTheme({
        ...userTheme,
        userCodeFontFamily: value
      })
    },
    [setUserTheme, userTheme]
  )

  const renderFontOption = useCallback(
    (font: string) => (
      <Tooltip title={font} placement="left" mouseEnterDelay={0.5}>
        <div
          className="truncate"
          style={{
            fontFamily: font
          }}>
          {font}
        </div>
      </Tooltip>
    ),
    []
  )

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.display.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.theme.mode')}</SettingRowTitle>
          <Segmented
            aria-label={t('settings.theme.mode')}
            value={settedTheme}
            onChange={setTheme}
            options={[
              { value: ThemeMode.light, label: t('settings.theme.light') },
              { value: ThemeMode.dark, label: t('settings.theme.dark') },
              { value: ThemeMode.system, label: t('settings.theme.system') }
            ]}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRowTitle id="theme-preset-title">{t('settings.theme.preset.title')}</SettingRowTitle>
        <PresetChoices role="group" aria-labelledby="theme-preset-title">
          {UI_THEME_PRESETS.map((choice) => {
            const colors = THEME_PRESET_ANTD_TOKENS[choice][theme]
            return (
              <PresetChoice
                key={choice}
                type="button"
                aria-pressed={choice === preset}
                onClick={() => setPreset(choice)}>
                <PalettePreview aria-hidden="true" $frame={colors.frame} $sidebar={colors.sidebar}>
                  <PaletteCanvas $canvas={colors.canvas} $text={colors.text} $accent={colors.accent} />
                </PalettePreview>
                <strong>
                  {choice === 'codex'
                    ? t('settings.theme.preset.codex.name')
                    : t('settings.theme.preset.zen-paper.name')}
                </strong>
                <span>
                  {choice === 'codex'
                    ? t('settings.theme.preset.codex.description')
                    : t('settings.theme.preset.zen-paper.description')}
                </span>
              </PresetChoice>
            )
          })}
        </PresetChoices>
        {isMac && (
          <>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.theme.window.style.transparent')}</SettingRowTitle>
              <Switch checked={windowStyle === 'transparent'} onChange={handleWindowStyleChange} />
            </SettingRow>
          </>
        )}
        {isLinux && (
          <>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.use_system_title_bar.title')}</SettingRowTitle>
              <Switch checked={useSystemTitleBar} onChange={handleUseSystemTitleBarChange} />
            </SettingRow>
          </>
        )}
      </SettingGroup>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.display.zoom.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.zoom.title')}</SettingRowTitle>
          <ZoomButtonGroup>
            <Button onClick={() => handleZoomFactor(-0.1)} icon={<Minus size="14" />} color="default" variant="text" />
            <ZoomValue>{Math.round(currentZoom * 100)}%</ZoomValue>
            <Button onClick={() => handleZoomFactor(0.1)} icon={<Plus size="14" />} color="default" variant="text" />
            <Button
              onClick={() => handleZoomFactor(0, true)}
              style={{ marginLeft: 8 }}
              icon={<ResetIcon size="14" />}
              color="default"
              variant="text"
            />
          </ZoomButtonGroup>
        </SettingRow>
      </SettingGroup>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.display.conversation.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.display.conversation.font_size')}</SettingRowTitle>
          <ZoomValue>{conversationFontSize === 12 ? t('common.default') : `+${conversationFontSize - 12}px`}</ZoomValue>
        </SettingRow>
        <Slider
          value={conversationFontSize}
          min={12}
          max={22}
          step={1}
          marks={{
            12: <span style={{ fontSize: '12px' }}>{t('common.default')}</span>,
            22: <span style={{ fontSize: '18px' }}>A</span>
          }}
          onChange={(value) => dispatch(setConversationFontSize(value))}
        />
        <SettingDescription>{t('settings.display.conversation.description')}</SettingDescription>
      </SettingGroup>
      <SettingGroup theme={theme}>
        <SettingTitle style={{ justifyContent: 'flex-start', gap: 5 }}>
          {t('settings.display.font.title')} <TextBadge text="New" />
        </SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.display.font.global')}</SettingRowTitle>
          <SelectRow>
            <Select
              style={{ width: 280 }}
              placeholder={t('settings.display.font.select')}
              options={[
                {
                  label: <span style={{ fontFamily: 'var(--zen-ui-font)' }}>{t('settings.theme.preset.font')}</span>,
                  value: ''
                },
                ...fontList.map((font) => ({ label: renderFontOption(font), value: font }))
              ]}
              value={userTheme.userFontFamily || ''}
              onChange={(font) => handleUserFontChange(font)}
              showSearch
              getPopupContainer={(triggerNode) => triggerNode.parentElement || document.body}
            />
            <Button
              onClick={() => handleUserFontChange('')}
              style={{ marginLeft: 8 }}
              icon={<ResetIcon size="14" />}
              color="default"
              variant="text"
            />
          </SelectRow>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.display.font.code')}</SettingRowTitle>
          <SelectRow>
            <Select
              style={{ width: 280 }}
              placeholder={t('settings.display.font.select')}
              options={[
                {
                  label: <span style={{ fontFamily: 'var(--zen-code-font)' }}>{t('settings.theme.preset.font')}</span>,
                  value: ''
                },
                ...fontList.map((font) => ({ label: renderFontOption(font), value: font }))
              ]}
              value={userTheme.userCodeFontFamily || ''}
              onChange={(font) => handleUserCodeFontChange(font)}
              showSearch
              getPopupContainer={(triggerNode) => triggerNode.parentElement || document.body}
            />
            <Button
              onClick={() => handleUserCodeFontChange('')}
              style={{ marginLeft: 8 }}
              icon={<ResetIcon size="14" />}
              color="default"
              variant="text"
            />
          </SelectRow>
        </SettingRow>
      </SettingGroup>
      <SettingGroup theme={theme}>
        <SettingTitle style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('settings.display.sidebar.title')}</span>
          <Button size="small" onClick={() => uiSidebarPlacements.reset()}>
            {t('common.reset')}
          </Button>
        </SettingTitle>
        <SettingDescription style={{ marginTop: 2, marginBottom: 10 }}>
          {t('app_shell.sidebar_placement_desc', '自定义每个导航入口展示在侧边栏最外层、收入「更多工具」，或隐藏。')}
        </SettingDescription>
        <SettingDivider />
        <SidebarPlacementList>
          {sidebarEntries.map((entry) => {
            const Icon = entry.icon
            const options: Array<{ label: string; value: SidebarEntryPlacement }> = [
              { label: t('app_shell.sidebar_placement_primary', '外层显示'), value: 'primary' },
              { label: t('app_shell.sidebar_placement_more', '更多工具'), value: 'more' }
            ]
            if (!entry.required) {
              options.push({ label: t('app_shell.sidebar_placement_hidden', '隐藏'), value: 'hidden' })
            }
            return (
              <SidebarPlacementRow key={entry.id}>
                <SidebarPlacementInfo>
                  <SidebarPlacementIcon>
                    <Icon size={15} />
                  </SidebarPlacementIcon>
                  <span>{t(entry.labelKey)}</span>
                </SidebarPlacementInfo>
                <Segmented
                  size="small"
                  shape="round"
                  value={sidebarPlacements[entry.id]}
                  onChange={(value) => uiSidebarPlacements.setPlacement(entry.id, value)}
                  options={options}
                />
              </SidebarPlacementRow>
            )
          })}
        </SidebarPlacementList>
      </SettingGroup>
    </SettingContainer>
  )
}

const PresetChoices = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 10px 0 2px;
`

const PresetChoice = styled.button`
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 10px;
  color: var(--zen-text-1);
  text-align: start;
  background: var(--zen-glass-card);
  backdrop-filter: blur(20px) saturate(160%);
  border: 0;
  box-shadow: var(--zen-shadow-card);
  border-radius: var(--zen-radius-md);
  cursor: pointer;
  transition:
    background 160ms ease,
    box-shadow 180ms ease,
    transform 150ms ease;

  &:hover {
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    transform: translateY(-0.5px);
  }

  &[aria-pressed='true'] {
    background: var(--zen-glass-active);
    box-shadow:
      0 0 0 1.5px var(--zen-success),
      var(--zen-shadow-pill);
  }

  &:focus-visible {
    outline: 2px solid var(--zen-accent);
    outline-offset: 2px;
  }

  > span {
    color: var(--zen-text-2);
    font-size: 12px;
  }
`

const PalettePreview = styled.div<{ $frame: string; $sidebar: string }>`
  display: flex;
  height: 56px;
  padding: 8px 4px 4px 25%;
  background: linear-gradient(to right, ${({ $sidebar }) => $sidebar} 25%, ${({ $frame }) => $frame} 25%);
  border: 1px solid var(--zen-border);
  border-radius: var(--zen-radius-sm);
`

const PaletteCanvas = styled.div<{ $canvas: string; $text: string; $accent: string }>`
  flex: 1;
  display: grid;
  align-content: center;
  gap: 6px;
  padding: 8px;
  background: ${({ $canvas }) => $canvas};
  border-radius: 4px;

  &::before,
  &::after {
    content: '';
    height: 3px;
    border-radius: 2px;
  }

  &::before {
    width: 56%;
    background: ${({ $text }) => $text};
    opacity: 0.7;
  }

  &::after {
    width: 25%;
    background: ${({ $accent }) => $accent};
  }
`

const ZoomButtonGroup = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 210px;
`
const ZoomValue = styled.span`
  width: 40px;
  text-align: center;
  margin: 0 5px;
`

const SettingDescription = styled.div`
  margin-top: 4px;
  color: var(--color-text-3);
  font-size: 12px;
  line-height: 1.5;
`

const SelectRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 380px;
`

const SidebarPlacementList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
`

const SidebarPlacementRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--zen-radius-sm);
  background: var(--zen-bg-subtle);
  transition: background 150ms ease;

  &:hover {
    background: var(--zen-bg-hover);
  }
`

const SidebarPlacementInfo = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: var(--zen-text-1);
  font-size: 13px;
  font-weight: 500;
`

const SidebarPlacementIcon = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--zen-glass-pill);
  box-shadow: var(--zen-shadow-active);
  color: var(--zen-text-2);
  flex: none;
`

export default DisplaySettings
