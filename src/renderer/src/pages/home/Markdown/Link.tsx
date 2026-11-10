import { parseJSON } from '@renderer/utils/json'
import { findCitationInChildren } from '@renderer/utils/markdown'
import { isEmpty, omit } from 'lodash'
import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Node } from 'unist'

import CitationTooltip, { CitationSchema } from './CitationTooltip'
import Hyperlink from './Hyperlink'
import { localFilePath } from './localFileLink'

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  node?: Omit<Node, 'type'>
}

const Link: React.FC<LinkProps> = (props) => {
  const { t } = useTranslation()
  const filePath = localFilePath(props.href ?? '')
  const citationData = useMemo(() => {
    const raw = parseJSON(findCitationInChildren(props.children))
    const parsed = CitationSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }, [props.children])

  if (filePath) {
    return (
      <a
        {...omit(props, ['node', 'citationData', 'target'])}
        title={filePath}
        onClick={async (event) => {
          event.preventDefault()
          event.stopPropagation()
          try {
            const [check] = await window.api.file.checkPaths([filePath])
            if (check?.status !== 'available') {
              window.toast.error(
                t(
                  check?.status === 'missing' ? 'chat.input.tools.file_not_found' : 'chat.input.tools.open_file_error',
                  { path: filePath }
                )
              )
              return
            }
            await window.api.file.openPath(filePath)
          } catch {
            window.toast.error(t('chat.input.tools.open_file_error', { path: filePath }))
          }
        }}
      />
    )
  }

  // 处理内部链接
  if (props.href?.startsWith('#')) {
    return <span className="link">{props.children}</span>
  }

  // 包含<sup>标签表示是一个引用链接
  const isCitation = React.Children.toArray(props.children).some((child) => {
    if (typeof child === 'object' && 'type' in child) {
      return child.type === 'sup'
    }
    return false
  })

  // 如果是引用链接并且有引用数据，则使用CitationTooltip
  if (isCitation && citationData) {
    return (
      <CitationTooltip citation={citationData}>
        <a
          {...omit(props, ['node', 'citationData'])}
          href={isEmpty(props.href) ? undefined : props.href}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        />
      </CitationTooltip>
    )
  }

  // 普通链接
  return (
    <Hyperlink href={props.href || ''}>
      <a
        {...omit(props, ['node', 'citationData'])}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      />
    </Hyperlink>
  )
}

export default Link
