import { useSettings } from '@renderer/hooks/useSettings'
import { getCustomPrimary, getPrimaryForeground } from '@renderer/hooks/useUserTheme'
import type { UiThemePreset } from '@renderer/services/UiThemePresetService'
import type { LanguageVarious } from '@renderer/types'
import { ConfigProvider, theme } from 'antd'
import deDE from 'antd/locale/de_DE'
import elGR from 'antd/locale/el_GR'
import enUS from 'antd/locale/en_US'
import esES from 'antd/locale/es_ES'
import frFR from 'antd/locale/fr_FR'
import jaJP from 'antd/locale/ja_JP'
import ptPT from 'antd/locale/pt_PT'
import roRO from 'antd/locale/ro_RO'
import ruRU from 'antd/locale/ru_RU'
import zhCN from 'antd/locale/zh_CN'
import zhTW from 'antd/locale/zh_TW'
import type { FC, PropsWithChildren } from 'react'

import { type ResolvedThemeMode, useTheme } from './ThemeProvider'

export const THEME_PRESET_ANTD_TOKENS = {
  codex: {
    light: {
      frame: '#f7f7f7',
      sidebar: '#ffffff',
      canvas: '#f9f9f9',
      elevated: '#ffffff',
      subtle: '#f2f2f2',
      border: '#ececec',
      borderStrong: '#dcdcdc',
      accent: '#1c1c1e',
      accentText: '#ffffff',
      text: '#171719',
      textSecondary: '#4a4a4f',
      textTertiary: '#6e6e73',
      textQuaternary: '#86868b'
    },
    dark: {
      frame: '#131315',
      sidebar: '#1e1e21',
      canvas: '#151517',
      elevated: '#222226',
      subtle: '#2a2a2f',
      border: '#323238',
      borderStrong: '#44444d',
      accent: '#f5f5f7',
      accentText: '#141416',
      text: '#f5f5f7',
      textSecondary: '#b8b8bf',
      textTertiary: '#8e8e96',
      textQuaternary: '#787880'
    }
  },
  'zen-paper': {
    light: {
      frame: '#f4eee4',
      sidebar: '#fffdf9',
      canvas: '#faf6ef',
      elevated: '#fffdf9',
      subtle: '#efe7dc',
      border: '#e2d8ca',
      borderStrong: '#cfc2b0',
      accent: '#24201a',
      accentText: '#fefcf8',
      text: '#1e1b16',
      textSecondary: '#524b41',
      textTertiary: '#746b5e',
      textQuaternary: '#8c8375'
    },
    dark: {
      frame: '#161412',
      sidebar: '#221f1c',
      canvas: '#181613',
      elevated: '#272420',
      subtle: '#312d28',
      border: '#3b362f',
      borderStrong: '#4e473e',
      accent: '#f4f0e8',
      accentText: '#181613',
      text: '#f5f1e9',
      textSecondary: '#bfb7aa',
      textTertiary: '#988f81',
      textQuaternary: '#80786b'
    }
  }
} satisfies Record<UiThemePreset, Record<ResolvedThemeMode, Record<string, string>>>

const AntdProvider: FC<PropsWithChildren> = ({ children }) => {
  const {
    language,
    userTheme: { colorPrimary }
  } = useSettings()
  const { preset, theme: mode } = useTheme()
  const palette = THEME_PRESET_ANTD_TOKENS[preset][mode]
  const customPrimary = getCustomPrimary(colorPrimary)
  const primaryColor = customPrimary ? getPrimaryForeground(customPrimary) : palette.accentText
  const fieldTokens = {
    controlHeight: 32,
    colorBorder: palette.border,
    hoverBorderColor: palette.borderStrong,
    activeBorderColor: palette.borderStrong
  }

  return (
    <ConfigProvider
      locale={getAntdLocale(language)}
      theme={{
        cssVar: true,
        hashed: false,
        algorithm: [mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm],
        components: {
          Menu: {
            activeBarBorderWidth: 0,
            darkItemBg: 'transparent'
          },
          Button: {
            boxShadow: 'none',
            boxShadowSecondary: 'none',
            defaultShadow: 'none',
            dangerShadow: 'none',
            primaryShadow: 'none',
            primaryColor,
            controlHeight: 32,
            borderRadius: 10,
            paddingInline: 12
          },
          Input: {
            ...fieldTokens,
            activeShadow: 'none'
          },
          InputNumber: {
            ...fieldTokens,
            activeShadow: 'none'
          },
          Select: {
            ...fieldTokens,
            activeOutlineColor: 'transparent'
          },
          Collapse: {
            headerBg: 'transparent'
          },
          Tooltip: {
            fontSize: 13
          },
          ColorPicker: {
            fontFamily: 'var(--code-font-family)'
          },
          Segmented: {
            itemActiveBg: palette.canvas,
            itemSelectedBg: palette.canvas,
            itemHoverBg: palette.elevated,
            trackBg: palette.subtle
          },
          Switch: {
            colorTextQuaternary: 'rgba(153,153,153,0.20)',
            trackMinWidth: 40,
            handleSize: 19,
            trackMinWidthSM: 28,
            trackHeightSM: 17,
            handleSizeSM: 14,
            trackPadding: 1.5
          },
          Dropdown: {
            controlPaddingHorizontal: 8,
            borderRadiusLG: 14,
            borderRadiusSM: 10,
            paddingXS: 5
          },
          Popover: {
            borderRadiusLG: 14
          },
          Slider: {
            handleLineWidth: 1.5,
            handleSize: 15,
            handleSizeHover: 15,
            dotSize: 7,
            railSize: 5
          },
          Modal: {
            colorBgElevated: palette.elevated
          },
          Divider: {
            colorSplit: 'rgba(128,128,128,0.15)'
          },
          Splitter: {
            splitBarDraggableSize: 0,
            splitBarSize: 0.5,
            splitTriggerSize: 10
          }
        },
        token: {
          colorPrimary: customPrimary?.hex() ?? palette.accent,
          colorTextLightSolid: primaryColor,
          colorTextBase: palette.text,
          colorText: palette.text,
          colorTextSecondary: palette.textSecondary,
          colorTextTertiary: palette.textTertiary,
          colorTextQuaternary: palette.textQuaternary,
          colorTextDescription: palette.textSecondary,
          colorTextPlaceholder: palette.textTertiary,
          colorTextDisabled: palette.textQuaternary,
          colorBgBase: palette.canvas,
          colorBgContainer: palette.canvas,
          colorBgElevated: palette.elevated,
          colorBorder: palette.border,
          colorBorderSecondary: palette.border,
          borderRadius: 10,
          fontFamily: 'var(--font-family)',
          colorBgMask: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.24)',
          motionDurationMid: '180ms',
          motionEaseOut: 'cubic-bezier(0.22, 1, 0.36, 1)'
        }
      }}>
      {children}
    </ConfigProvider>
  )
}

function getAntdLocale(language: LanguageVarious) {
  switch (language) {
    case 'zh-CN':
      return zhCN
    case 'zh-TW':
      return zhTW
    case 'en-US':
      return enUS
    case 'de-DE':
      return deDE
    case 'ru-RU':
      return ruRU
    case 'ja-JP':
      return jaJP
    case 'el-GR':
      return elGR
    case 'es-ES':
      return esES
    case 'fr-FR':
      return frFR
    case 'pt-PT':
      return ptPT
    case 'ro-RO':
      return roRO
    default:
      return zhCN
  }
}

export default AntdProvider
