import { APP_NAME, AppLogo } from '@renderer/config/env'
import { useAppStore } from '@renderer/store'
import { Button } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import type { OnboardingStep } from '../OnboardingPage'
import ProviderPopup from './ProviderPopup'

interface WelcomePageProps {
  setStep: (step: OnboardingStep) => void
  setCherryInLoggedIn: (loggedIn: boolean) => void
}

const WelcomePage: FC<WelcomePageProps> = ({ setStep }) => {
  const { t } = useTranslation()
  const store = useAppStore()

  const handleSelectProvider = async () => {
    await ProviderPopup.show()
    const hasAvailableProvider = store.getState().llm.providers.some((p) => p.enabled && p.models.length > 0)
    if (hasAvailableProvider) {
      setStep('select-model')
    }
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-6">
      <div
        className="flex w-full max-w-[460px] flex-col items-center gap-6 px-10 py-11"
        style={{
          borderRadius: 'var(--zen-radius-xl)',
          background: 'var(--zen-glass-card)',
          backdropFilter: 'blur(32px) saturate(165%)',
          WebkitBackdropFilter: 'blur(32px) saturate(165%)',
          boxShadow: 'var(--zen-shadow-composer)'
        }}>
        <div
          className="flex h-[72px] w-[72px] items-center justify-center rounded-2xl"
          style={{ background: 'var(--zen-glass-pill)', boxShadow: 'var(--zen-shadow-pill)' }}>
          <img src={AppLogo} alt={APP_NAME} className="h-14 w-14 rounded-xl" />
        </div>

        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="m-0 font-semibold text-(--zen-text-1) text-2xl tracking-tight">
            {t('onboarding.welcome.title')}
          </h1>
          <p className="m-0 text-(--zen-text-2) text-sm">{t('onboarding.welcome.subtitle')}</p>
        </div>

        <div className="mt-2 flex w-full flex-col gap-3">
          <Button
            type="primary"
            size="large"
            shape="round"
            block
            className="h-11 font-medium"
            onClick={handleSelectProvider}>
            {t('onboarding.welcome.other_provider')}
          </Button>
        </div>

        <p className="m-0 text-center text-(--zen-text-3) text-xs">{t('onboarding.welcome.setup_hint')}</p>
      </div>
    </div>
  )
}

export default WelcomePage
