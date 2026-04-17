import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import type { Assistant } from '@renderer/types'
import { Popover } from 'antd'
import { ChevronsUpDown } from 'lucide-react'
import type { FC } from 'react'
import styled from 'styled-components'

interface Props {
  assistant: Assistant
  assistants: Assistant[]
  onSelectAssistant: (assistant: Assistant) => void
}

const AssistantSwitchButton: FC<Props> = ({ assistant, assistants, onSelectAssistant }) => {
  const options = assistants.filter((item) => item.id)

  return (
    <Popover
      arrow={false}
      trigger="click"
      placement="bottomLeft"
      content={
        <AssistantMenu>
          {options.map((item) => (
            <AssistantMenuItem
              key={item.id}
              className={item.id === assistant.id ? 'active' : undefined}
              onClick={() => onSelectAssistant(item)}>
              <AssistantAvatar assistant={item} size={20} />
              <AssistantName>{item.name}</AssistantName>
            </AssistantMenuItem>
          ))}
        </AssistantMenu>
      }>
      <SwitchButton type="button">
        <ButtonContent>
          <AssistantAvatar assistant={assistant} size={20} />
          <AssistantName>{assistant.name}</AssistantName>
        </ButtonContent>
        <ChevronsUpDown size={14} color="var(--color-icon)" />
      </SwitchButton>
    </Popover>
  )
}

const SwitchButton = styled.button`
  height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border-radius: 999px;
  padding: 0 14px;
  -webkit-app-region: none;
  box-shadow: 0 8px 20px rgba(149, 157, 165, 0.1);
  background: rgba(255, 255, 255, 0.94);
  border: none;
  color: #1f2329;
  cursor: pointer;
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
  gap: 4px;
  min-width: 220px;
`

const AssistantMenuItem = styled.button`
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  border: none;
  background: transparent;
  padding: 8px 10px;
  border-radius: 12px;
  cursor: pointer;
  color: var(--color-text);

  &:hover,
  &.active {
    background: var(--color-background-soft);
  }
`

const AssistantName = styled.span`
  font-size: 12px;
  font-weight: 500;
  color: #1f2329;
  max-width: 196px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export default AssistantSwitchButton
