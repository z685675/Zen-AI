import { useCallback, useState } from 'react'

const ONBOARDING_COMPLETED_KEY = 'onboarding-completed'

export function useOnboardingState() {
  const [onboardingCompleted, setOnboardingCompleted] = useState(() => {
    // Zen AI skips the upstream onboarding flow and enters the app directly.
    localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true')
    return true
  })

  const completeOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true')
    setOnboardingCompleted(true)
  }, [])

  return {
    onboardingCompleted,
    completeOnboarding
  }
}
