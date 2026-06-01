import Scrollbar from '@renderer/components/Scrollbar'
import styled from 'styled-components'

export const ScrollContainer = styled.div`
  display: flex;
  flex-direction: column-reverse;
  padding: 10px 10px 20px;
  .multi-select-mode & {
    padding-bottom: 60px;
  }
`

interface ContainerProps {
  $right?: boolean
}

export const MessagesContainer = styled(Scrollbar)<ContainerProps>`
  display: flex;
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
