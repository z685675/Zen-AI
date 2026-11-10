import { AgentWorkspaceContext } from '@renderer/context/AgentWorkspaceProvider'
import { useDshPreviewStatus } from '@renderer/services/DshPreviewService'
import { Spin } from 'antd'
import { Navigate } from 'react-router-dom'

import AgentPage from './AgentPage'

export default function DshPreviewPage() {
  const status = useDshPreviewStatus()
  if (!status) return <Spin style={{ margin: 'auto' }} />
  if (!status.unlocked || status.state !== 'ready') return <Navigate to="/settings/general" replace />
  return (
    <AgentWorkspaceContext value="dsh">
      <AgentPage />
    </AgentWorkspaceContext>
  )
}
