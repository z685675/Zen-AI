import '@renderer/databases'

import { loggerService } from '@logger'
import { runStartupAssistantEnvironmentPreflight } from '@renderer/services/AssistantEnvironmentService'
import { startDefaultModelPolicyReconciler } from '@renderer/services/DefaultModelPolicyService'
import { startProviderModelSyncScheduler } from '@renderer/services/ProviderModelSyncService'
import store, { persistor } from '@renderer/store'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Provider } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'

import { ErrorBoundary } from './components/ErrorBoundary'
import TopViewContainer from './components/TopView'
import { AnnouncementProvider } from './context/AnnouncementProvider'
import AntdProvider from './context/AntdProvider'
import { CodeStyleProvider } from './context/CodeStyleProvider'
import { NotificationProvider } from './context/NotificationProvider'
import StyleSheetManager from './context/StyleSheetManager'
import { ThemeProvider } from './context/ThemeProvider'
import Router from './Router'

const logger = loggerService.withContext('App.tsx')

// 创建 React Query 客户端
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false
    }
  }
})

function App(): React.ReactElement {
  logger.info('App initialized')

  useEffect(() => {
    void runStartupAssistantEnvironmentPreflight()
    startDefaultModelPolicyReconciler()
    startProviderModelSyncScheduler()
  }, [])

  return (
    <ErrorBoundary>
      <Provider store={store}>
        <QueryClientProvider client={queryClient}>
          <StyleSheetManager>
            <ThemeProvider>
              <AntdProvider>
                <NotificationProvider>
                  <CodeStyleProvider>
                    <PersistGate loading={null} persistor={persistor}>
                      <AnnouncementProvider>
                        <TopViewContainer>
                          <Router />
                        </TopViewContainer>
                      </AnnouncementProvider>
                    </PersistGate>
                  </CodeStyleProvider>
                </NotificationProvider>
              </AntdProvider>
            </ThemeProvider>
          </StyleSheetManager>
        </QueryClientProvider>
      </Provider>
    </ErrorBoundary>
  )
}

export default App
