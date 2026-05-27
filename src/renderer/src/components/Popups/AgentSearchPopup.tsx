import { TopView } from '@renderer/components/TopView'
import AgentSearchPage from '@renderer/pages/agents/AgentSearchPage'
import { Modal } from 'antd'
import { useState } from 'react'

interface Props {
  resolve: (data: any) => void
}

const PopupContainer = ({ resolve }: Props) => {
  const [open, setOpen] = useState(true)

  const onClose = () => {
    setOpen(false)
  }

  const afterClose = () => {
    resolve({})
  }

  AgentSearchPopup.hide = onClose

  return (
    <Modal
      open={open}
      onCancel={onClose}
      afterClose={afterClose}
      title={null}
      width={700}
      transitionName="animation-move-down"
      styles={{
        content: {
          borderRadius: 20,
          padding: 0,
          overflow: 'hidden',
          paddingBottom: 16
        },
        body: {
          height: '80vh',
          maxHeight: 'inherit',
          padding: 0
        }
      }}
      centered
      closable={false}
      footer={null}>
      <AgentSearchPage onSelect={onClose} />
    </Modal>
  )
}

export default class AgentSearchPopup {
  static hide() {
    TopView.hide('AgentSearchPopup')
  }

  static show() {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          resolve={(value) => {
            resolve(value)
            TopView.hide('AgentSearchPopup')
          }}
        />,
        'AgentSearchPopup'
      )
    })
  }
}
