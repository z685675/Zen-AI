import Scrollbar from '@renderer/components/Scrollbar'
import styled from 'styled-components'

export const ScrollContainer = styled.div<{ $hasPrompt?: boolean }>`
  display: flex;
  flex-direction: column-reverse;
  gap: 14px;
  padding: ${({ $hasPrompt }) => ($hasPrompt ? '14px' : '68px')} 0 var(--zen-composer-inset, 152px);
  .multi-select-mode & {
    padding-bottom: calc(var(--zen-composer-inset, 152px) + 52px);
  }
`

interface ContainerProps {
  $right?: boolean
}

export const MessagesContainer = styled(Scrollbar)<ContainerProps>`
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column-reverse;
  overflow-x: hidden;
  z-index: 1;
  position: relative;

  &::-webkit-scrollbar {
    width: 12px;
  }

  &::-webkit-scrollbar-thumb {
    min-height: 56px;
    border: 3px solid transparent;
    border-radius: 999px;
    background-clip: content-box;
    background-color: var(--color-scrollbar-thumb);
  }

  &::-webkit-scrollbar-thumb:hover {
    background-color: var(--color-scrollbar-thumb-hover);
  }
`
