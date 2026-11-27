import ModelSettings from '@renderer/pages/settings/ModelSettings/ModelSettings'
import { Button } from 'antd'
import { ArrowLeft } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import type { OnboardingStep } from '../OnboardingPage'

interface SelectModelPageProps {
  cherryInLoggedIn: boolean
  setStep: (step: OnboardingStep) => void
  onComplete: () => void
}

const SelectModelPage: FC<SelectModelPageProps> = ({ cherryInLoggedIn, setStep, onComplete }) => {
  const { t } = useTranslation()

  const handleBack = () => {
    setStep('welcome')
  }

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center p-6">
      {!cherryInLoggedIn && (
        <Button
          type="text"
          shape="circle"
          icon={<ArrowLeft size={18} />}
          style={{
            position: 'absolute',
            top: 16,
            left: 16,
            background: 'var(--zen-glass-pill)',
            boxShadow: 'var(--zen-shadow-pill)',
            color: 'var(--zen-text-2)'
          }}
          onClick={handleBack}
        />
      )}
      <div
        className="flex w-full max-w-[460px] flex-col gap-6 px-9 py-10"
        style={{
          borderRadius: 'var(--zen-radius-xl)',
          background: 'var(--zen-glass-card)',
          backdropFilter: 'blur(32px) saturate(165%)',
          WebkitBackdropFilter: 'blur(32px) saturate(165%)',
          boxShadow: 'var(--zen-shadow-composer)'
        }}>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 font-semibold text-(--zen-text-1) text-2xl tracking-tight">
            {t('onboarding.select_model.title')}
          </h1>
          <p className="m-0 text-(--zen-text-2) text-sm">{t('onboarding.select_model.subtitle')}</p>
        </div>

        <ModelSettings showSettingsButton={false} showDescription={false} compact />

        <Button type="primary" size="large" shape="round" block className="h-11 font-medium" onClick={onComplete}>
          {t('onboarding.select_model.start')}
        </Button>

        <p className="m-0 text-center text-(--zen-text-3) text-xs">{t('onboarding.select_model.change_later')}</p>
      </div>
    </div>
  )
}

export default SelectModelPage
