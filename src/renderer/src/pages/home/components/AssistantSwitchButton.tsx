import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import type { Assistant } from '@renderer/types'
import { Popover } from 'antd'
import { ChevronsUpDown } from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import styled from 'styled-components'

interface Props {
  assistant: Assistant
  assistants: Assistant[]
  onSelectAssistant: (assistant: Assistant) => void
}

const AssistantSwitchButton: FC<Props> = ({ assistant, assistants, onSelectAssistant }) => {
  const [open, setOpen] = useState(false)
  const options = assistants.filter((item) => item.id)

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      arrow={false}
      trigger="click"
      placement="bottomLeft"
      content={
        <AssistantMenu>
          {options.map((item) => (
            <AssistantMenuItem
              key={item.id}
              className={item.id === assistant.id ? 'active' : undefined}
              onClick={() => {
                onSelectAssistant(item)
                setOpen(false)
              }}>
              <AssistantAvatar assistant={item} size={20} />
              <AssistantName>{item.name}</AssistantName>
            </AssistantMenuItem>
          ))}
        </AssistantMenu>
      }>
      <SwitchButton type="button">
        <ButtonContent>
          <AssistantAvatar assistant={assistant} size={18} />
          <AssistantName>{assistant.name}</AssistantName>
        </ButtonContent>
        <ChevronsUpDown size={13} color="var(--zen-text-3)" />
      </SwitchButton>
    </Popover>
  )
}

const SwitchButton = styled.button`
  height: 35px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: var(--zen-radius-pill);
  padding: 0 14px 0 10px;
  -webkit-app-region: no-drag;
  background: var(--zen-glass-pill);
  backdrop-filter: blur(28px) saturate(170%);
  -webkit-backdrop-filter: blur(28px) saturate(170%);
  border: 0;
  box-shadow: var(--zen-shadow-pill);
  color: var(--zen-text-1);
  cursor: pointer;
  transition:
    background 160ms ease,
    box-shadow 180ms ease,
    transform 150ms cubic-bezier(0.22, 1, 0.36, 1);

  &:hover {
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    transform: translateY(-0.5px);
  }

  &:active {
    transform: scale(0.985);
  }
`

const ButtonContent = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
`

const AssistantMenu = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 220px;
  max-height: min(52vh, 420px);
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: var(--color-scrollbar-thumb);
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }
`

const AssistantMenuItem = styled.button`
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  padding: 7px 8px;
  border-radius: var(--zen-radius-sm);
  cursor: pointer;
  color: var(--zen-text-1);

  &:hover {
    background: var(--zen-bg-hover);
  }

  &.active {
    background: var(--zen-bg-active);
  }
`

const AssistantName = styled.span`
  font-size: 12px;
  font-weight: 500;
  color: var(--zen-text-1);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export default AssistantSwitchButton
