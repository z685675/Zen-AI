import { HStack } from '@renderer/components/Layout'

import SettingsButton from './SettingsButton'

const Tools = () => {
  return (
    <HStack alignItems="center" gap={8}>
      <SettingsButton />
    </HStack>
  )
}

export default Tools
