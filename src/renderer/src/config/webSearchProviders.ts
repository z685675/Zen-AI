import type { WebSearchProvider, WebSearchProviderId } from '@renderer/types'

type WebSearchProviderConfig = {
  websites: {
    official: string
    apiKey?: string
  }
}

export const WEB_SEARCH_PROVIDER_CONFIG: Record<WebSearchProviderId, WebSearchProviderConfig> = {
  'auto-free': {
    websites: {
      official: 'https://exa.ai'
    }
  },
  zhipu: {
    websites: {
      official: 'https://docs.bigmodel.cn/cn/guide/tools/web-search',
      apiKey: 'https://zhipuaishengchan.datasink.sensorsdata.cn/t/yv'
    }
  },
  tavily: {
    websites: {
      official: 'https://tavily.com',
      apiKey: 'https://app.tavily.com/home'
    }
  },
  searxng: {
    websites: {
      official: 'https://docs.searxng.org'
    }
  },
  exa: {
    websites: {
      official: 'https://exa.ai',
      apiKey: 'https://dashboard.exa.ai/api-keys'
    }
  },
  'exa-mcp': {
    websites: {
      official: 'https://exa.ai'
    }
  },
  bocha: {
    websites: {
      official: 'https://bochaai.com',
      apiKey: 'https://open.bochaai.com/overview'
    }
  },
  'local-google': {
    websites: {
      official: 'https://www.google.com'
    }
  },
  'local-bing': {
    websites: {
      official: 'https://www.bing.com'
    }
  },
  'local-baidu': {
    websites: {
      official: 'https://www.baidu.com'
    }
  },
  'local-duckduckgo': {
    websites: {
      official: 'https://duckduckgo.com'
    }
  },
  querit: {
    websites: {
      official: 'https://querit.ai',
      apiKey: 'https://www.querit.ai/en/dashboard/api-keys'
    }
  }
}

export const WEB_SEARCH_PROVIDERS: WebSearchProvider[] = [
  {
    id: 'auto-free',
    name: '自动搜索（免费）'
  },
  {
    id: 'zhipu',
    name: 'Zhipu',
    apiHost: 'https://open.bigmodel.cn/api/paas/v4/web_search',
    apiKey: ''
  },
  {
    id: 'tavily',
    name: 'Tavily',
    apiHost: 'https://api.tavily.com',
    apiKey: ''
  },
  {
    id: 'searxng',
    name: 'Searxng',
    apiHost: '',
    basicAuthUsername: '',
    basicAuthPassword: ''
  },
  {
    id: 'exa',
    name: 'Exa',
    apiHost: 'https://api.exa.ai',
    apiKey: ''
  },
  {
    id: 'exa-mcp',
    name: 'ExaMCP',
    apiHost: 'https://mcp.exa.ai/mcp'
  },
  {
    id: 'bocha',
    name: 'Bocha',
    apiHost: 'https://api.bochaai.com',
    apiKey: ''
  },
  {
    id: 'local-google',
    name: 'Google',
    url: 'https://www.google.com/search?q=%s'
  },
  {
    id: 'local-bing',
    name: 'Bing',
    url: 'https://cn.bing.com/search?q=%s&setlang=zh-cn&cc=cn'
  },
  {
    id: 'local-baidu',
    name: 'Baidu',
    url: 'https://www.baidu.com/s?wd=%s'
  },
  {
    id: 'local-duckduckgo',
    name: 'DuckDuckGo',
    url: 'https://html.duckduckgo.com/html/?q=%s'
  },
  {
    id: 'querit',
    name: 'Querit',
    apiHost: 'https://api.querit.ai',
    apiKey: ''
  }
] as const
