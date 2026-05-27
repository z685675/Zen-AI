import { useSettings } from '@renderer/hooks/useSettings'
import type { FC, HTMLAttributes } from 'react'
import styled from 'styled-components'

interface Props extends HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  contentMaxWidth?: string
}

const NarrowLayout: FC<Props> = ({ children, contentMaxWidth, ...props }) => {
  const { narrowMode } = useSettings()

  return (
    <Container className={`narrow-mode ${narrowMode ? 'active' : ''}`} $contentMaxWidth={contentMaxWidth} {...props}>
      {children}
    </Container>
  )
}

const Container = styled.div<{ $contentMaxWidth?: string }>`
  max-width: 100%;
  width: 100%;
  margin: 0 auto;
  position: relative;
  transition: max-width 0.3s ease-in-out;

  &.active {
    max-width: ${({ $contentMaxWidth }) => $contentMaxWidth ?? '800px'};
  }
`

export default NarrowLayout
