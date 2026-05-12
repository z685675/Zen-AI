import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { Button } from 'antd'
import { BookOpenCheck, FileText, LibraryBig, Plus, Rows3, Sparkles } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

type ResearchModule = 'overview' | 'literatures' | 'cards' | 'matrix' | 'review'

type ModuleItem = {
  key: ResearchModule
  icon: ReactNode
  labelKey: string
  titleKey: string
  descriptionKey: string
}

const modules: ModuleItem[] = [
  {
    key: 'overview',
    icon: <Sparkles size={16} />,
    labelKey: 'research.modules.overview',
    titleKey: 'research.stage.overview.title',
    descriptionKey: 'research.stage.overview.description'
  },
  {
    key: 'literatures',
    icon: <LibraryBig size={16} />,
    labelKey: 'research.modules.literatures',
    titleKey: 'research.stage.literatures.title',
    descriptionKey: 'research.stage.literatures.description'
  },
  {
    key: 'cards',
    icon: <FileText size={16} />,
    labelKey: 'research.modules.cards',
    titleKey: 'research.stage.cards.title',
    descriptionKey: 'research.stage.cards.description'
  },
  {
    key: 'matrix',
    icon: <Rows3 size={16} />,
    labelKey: 'research.modules.matrix',
    titleKey: 'research.stage.matrix.title',
    descriptionKey: 'research.stage.matrix.description'
  },
  {
    key: 'review',
    icon: <BookOpenCheck size={16} />,
    labelKey: 'research.modules.review',
    titleKey: 'research.stage.review.title',
    descriptionKey: 'research.stage.review.description'
  }
]

const ResearchPage: FC = () => {
  const { t } = useTranslation()
  const [activeModule, setActiveModule] = useState<ResearchModule>('overview')
  const activeModuleMeta = modules.find((module) => module.key === activeModule) ?? modules[0]

  return (
    <Container id="research-page">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('research.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer>
        <ProjectSidebar>
          <SidebarHeader>
            <SidebarTitle>{t('research.projects.title')}</SidebarTitle>
            <Button size="small" type="text" icon={<Plus size={16} />} />
          </SidebarHeader>
          <EmptyProjectState>
            <EmptyProjectTitle>{t('research.projects.empty_title')}</EmptyProjectTitle>
            <EmptyProjectDescription>{t('research.projects.empty_description')}</EmptyProjectDescription>
          </EmptyProjectState>
        </ProjectSidebar>
        <MainContent>
          <OverviewPanel>
            <PanelEyebrow>{t('research.workspace.eyebrow')}</PanelEyebrow>
            <PageTitle>{t('research.workspace.title')}</PageTitle>
            <PageDescription>{t('research.workspace.description')}</PageDescription>
            <PrimaryActions>
              <Button type="primary" icon={<Plus size={16} />}>
                {t('research.actions.create_project')}
              </Button>
              <Button>{t('research.actions.import_pdf')}</Button>
            </PrimaryActions>
          </OverviewPanel>
          <ModuleGrid>
            {modules.map((module) => (
              <ModuleButton
                key={module.key}
                type="button"
                className={activeModule === module.key ? 'active' : ''}
                onClick={() => setActiveModule(module.key)}>
                {module.icon}
                <span>{t(module.labelKey)}</span>
              </ModuleButton>
            ))}
          </ModuleGrid>
          <StagePanel>
            <StageTitle>{t(activeModuleMeta.titleKey)}</StageTitle>
            <StageDescription>{t(activeModuleMeta.descriptionKey)}</StageDescription>
          </StagePanel>
        </MainContent>
        <AssistantPanel>
          <AssistantTitle>{t('research.assistant.title')}</AssistantTitle>
          <AssistantItem>{t('research.assistant.evidence_placeholder')}</AssistantItem>
          <AssistantItem>{t('research.assistant.next_step_placeholder')}</AssistantItem>
          <AssistantItem>{t('research.assistant.review_placeholder')}</AssistantItem>
        </AssistantPanel>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
  min-width: 0;
`

const ContentContainer = styled.div`
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 300px;
  flex: 1;
  min-height: 0;
  background: var(--color-background);
`

const ProjectSidebar = styled.aside`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  border-right: 0.5px solid var(--color-border);
  min-width: 0;
`

const SidebarHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`

const SidebarTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
`

const EmptyProjectState = styled.div`
  padding: 14px;
  border: 0.5px dashed var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
`

const EmptyProjectTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
`

const EmptyProjectDescription = styled.div`
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-text-2);
`

const MainContent = styled.main`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 22px;
  min-width: 0;
  overflow: auto;
`

const OverviewPanel = styled.section`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 18px;
  border-bottom: 0.5px solid var(--color-border);
`

const PanelEyebrow = styled.div`
  font-size: 12px;
  color: var(--color-primary);
  font-weight: 600;
`

const PageTitle = styled.h1`
  margin: 0;
  font-size: 24px;
  line-height: 1.25;
  color: var(--color-text);
  font-weight: 650;
`

const PageDescription = styled.p`
  margin: 0;
  max-width: 720px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--color-text-2);
`

const PrimaryActions = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
`

const ModuleGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(5, minmax(110px, 1fr));
  gap: 10px;
`

const ModuleButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 42px;
  padding: 0 12px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;

  &.active {
    border-color: var(--color-primary);
    color: var(--color-primary);
    background: var(--color-primary-mute);
  }
`

const StagePanel = styled.section`
  min-height: 220px;
  padding: 18px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
`

const StageTitle = styled.h2`
  margin: 0;
  font-size: 16px;
  color: var(--color-text);
`

const StageDescription = styled.p`
  margin: 10px 0 0;
  color: var(--color-text-2);
  font-size: 13px;
  line-height: 1.7;
`

const AssistantPanel = styled.aside`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-left: 0.5px solid var(--color-border);
  background: var(--color-background);
  min-width: 0;
`

const AssistantTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
`

const AssistantItem = styled.div`
  padding: 12px;
  border-radius: 8px;
  background: var(--color-background-soft);
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.6;
`

export default ResearchPage
