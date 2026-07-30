import { useSettings } from '@renderer/hooks/useSettings'
import type { FC, HTMLAttributes } from 'react'
import styled from 'styled-components'

interface Props extends HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  contentMaxWidth?: string
  reserveNavigationSpace?: boolean
}

const NarrowLayout: FC<Props> = ({ children, contentMaxWidth, reserveNavigationSpace = false, ...props }) => {
  const { narrowMode } = useSettings()

  return (
    <Container
      className={`narrow-mode ${narrowMode ? 'active' : ''}`}
      $contentMaxWidth={contentMaxWidth}
      $reserveNavigationSpace={reserveNavigationSpace}
      {...props}>
      {children}
    </Container>
  )
}

const Container = styled.div<{ $contentMaxWidth?: string; $reserveNavigationSpace: boolean }>`
  box-sizing: border-box;
  max-width: 100%;
  width: 100%;
  margin: 0 auto;
  padding-right: ${({ $reserveNavigationSpace }) => ($reserveNavigationSpace ? '68px' : '0')};
  position: relative;
  transition:
    max-width 0.3s ease-in-out,
    padding-right 0.2s ease;

  &.active {
    max-width: ${({ $contentMaxWidth }) => $contentMaxWidth ?? '800px'};
  }
`

export default NarrowLayout
