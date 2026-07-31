export type RealtimeSearchIntent = 'required' | 'not_needed' | 'uncertain'

const URL_PATTERN = /https?:\/\/\S+/i
const EXPLICIT_SEARCH_PATTERN =
  /(?:请|帮我|麻烦)?(?:搜索|搜一下|查一下|查一查|联网查|上网查|网上查|浏览网页|打开网页|检索网页|核实一下|在线核实)|(?:search|browse|look\s+up|check\s+online|verify\s+online|web\s+search)\b/i
const RECENCY_PATTERN =
  /(?:最新|当前|目前|现在的?|今日|今天|昨日|昨天|昨晚|明天|后天|本周|上周|下周|本月|上月|今年|刚刚|近期|最近|实时|截至|过去(?:\s*\d+\s*)?(?:小时|天|周|个月|年)|近(?:\s*\d+\s*)?(?:小时|天|周|个月|年)|现任|在任|\d{4}[年/-]\d{1,2}(?:[月/-]\d{1,2}日?)?)|\b(?:latest|current|currently|today|yesterday|tomorrow|this\s+week|last\s+week|next\s+week|this\s+month|recent|recently|real[- ]?time|up[- ]?to[- ]?date|as\s+of|past\s+\d+\s+(?:hours?|days?|weeks?|months?|years?))\b/i
const INHERENTLY_LIVE_PATTERN =
  /(?:天气|气温|降雨|下雨|降雪|台风|空气质量|新闻|热搜|热榜|日榜|周榜|月榜|实时榜|股价|股票行情|基金净值|汇率|比分|赛果|赛程|航班|机票|火车票|高铁票|路况|票房|彩票|开奖|几点|当前时间)|\b(?:weather|forecast|air\s+quality|news|trending|daily\s+(?:chart|ranking)|weekly\s+(?:chart|ranking)|monthly\s+(?:chart|ranking)|stock\s+price|share\s+price|exchange\s+rate|score|standings|schedule|flight|train|traffic|box\s+office|current\s+time|what\s+time)\b/i
const CHANGEABLE_FACT_PATTERN =
  /(?:价格|售价|政策|法律|法规|规则|版本|发布|更新|排名|排行榜|榜单|榜首|前十|负责人|总裁|首席执行官|CEO|总统|主席|市长|开放时间|营业时间|库存|是否在售|软件包|依赖库)|\b(?:price|pricing|policy|law|regulation|rule|version|release|update|ranking|chart|top\s*\d+|availability|in\s+stock|opening\s+hours|ceo|president|mayor|package|library)\b/i
const DYNAMIC_INFORMATION_PATTERN =
  /(?:热点|热门话题|要闻|快讯|资讯|动态|动向|进展|趋势|走势|舆情|行情|市场表现|财报|宏观数据|行业数据|事件盘点|晨报|晚报)|\b(?:hot\s+topics?|headlines?|breaking\s+news|updates?|developments?|trends?|market\s+movement|market\s+performance|earnings|financial\s+results|daily\s+brief|news\s+brief)\b/i
const INFORMATION_REQUEST_PATTERN =
  /(?:是什么|有什么|有哪些|发生了什么|怎么样|如何|情况|总结|整理|盘点|概览|速览|回顾|前十|榜首|排行|排名|表现)|\b(?:what|which|how|summary|summari[sz]e|roundup|overview|recap|top\s*\d+|ranking|performance)\b/i
const SUPPLIED_CONTENT_TASK_PATTERN =
  /(?:总结|整理|分析|提取|翻译|改写|润色|校对|排版)(?:这|以下|下面|上面|附件|文档|文件|图片|表格|内容|文字)|根据(?:这|以下|下面|上面|附件|文档|文件|图片|表格|内容)|把(?:这|以下|下面|上面).*(?:改成|整理成|翻译成)|\b(?:summari[sz]e|analy[sz]e|extract|translate|rewrite|polish|proofread|format)\s+(?:this|the\s+following|the\s+above|the\s+attached|the\s+document|the\s+file|the\s+image|the\s+table|the\s+content)\b/i
const TRANSFORMATION_TASK_PATTERN =
  /^(?:请|帮我|麻烦)?(?:翻译|改写|润色|校对|续写|排版)|把.{0,200}(?:翻译成|改写成|润色成|整理成)|\b(?:translate|rewrite|polish|proofread|continue|format)\b/i
const CREATIVE_TASK_PATTERN =
  /(?:写一首|写一篇|写一个|创作|起草|拟一份|编一个|讲一个故事|角色扮演)|\b(?:write|create|draft|compose|brainstorm|role[- ]?play)\b/i
const STABLE_EXPLANATION_PATTERN =
  /(?:是什么|什么意思|定义|概念|原理|基础知识|教程)|\b(?:what\s+is|what\s+does.+mean|definition|concept|principle|tutorial)\b/i
const PERSONAL_CONVERSATION_PATTERN =
  /(?:我(?:最近|今天|这几天).*(?:心情|感觉|难过|焦虑|开心|疲惫|迷茫|压力)|陪我聊|听我说)|\b(?:i(?:'m| am| have been).*(?:sad|anxious|happy|tired|confused|stressed)|talk\s+to\s+me)\b/i
const CURRENT_BENEFIT_PATTERN =
  /(?:推荐|对比|比较|选哪个|哪个好|哪一款|值得买|购买建议|旅行计划|旅游攻略|餐厅|酒店|市场调研|竞品分析)|\b(?:recommend|compare|comparison|which\s+one|worth\s+buying|buying\s+guide|travel\s+plan|restaurant|hotel|market\s+research|competitive\s+analysis)\b/i
const GREETING_PATTERN =
  /^(?:你好|您好|嗨|哈喽|早上好|下午好|晚上好|谢谢|感谢|再见|hi|hello|hey|thanks|thank\s+you|good\s+(?:morning|afternoon|evening))[!！,.，。?\s]*$/i
const SENSITIVE_CONTEXT_PATTERN =
  /(?:附件|本地文件|工作区|个人信息|隐私|私密|内部资料|账号|账户|银行卡|身份证|手机号|邮箱|密钥|令牌|密码|口令)|\b(?:attachment|local\s+file|workspace|personal\s+information|private|confidential|account|bank\s+card|identity\s+card|phone\s+number|email|api[-_ ]?key|access[-_ ]?token|password|secret)\b/i
const SECRET_ASSIGNMENT_PATTERN =
  /((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|password|passwd|secret|密钥|令牌|密码|口令)\s*[:=：]\s*)(?:"[^"]+"|'[^']+'|[^\s,，;；]+)/gi
const BEARER_TOKEN_PATTERN = /\bbearer\s+[a-z0-9._~+/-]+=*/gi
const COMMON_SECRET_PATTERN =
  /\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,}|AIza[a-z0-9_-]{20,}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/gi
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/g
const ID_CARD_PATTERN = /(?<!\d)\d{17}[\dXx](?!\d)/g
const WINDOWS_LOCAL_PATH_PATTERN = /\b[A-Za-z]:\\[^\r\n,，;；]*/g
const UNIX_LOCAL_PATH_PATTERN = /\/(?:Users|home)\/[^\s,，;；]*/g

const patternMatches = (pattern: RegExp, input: string): boolean => {
  pattern.lastIndex = 0
  return pattern.test(input)
}

export function containsSensitiveSearchContent(input: string): boolean {
  return (
    patternMatches(SENSITIVE_CONTEXT_PATTERN, input) ||
    patternMatches(SECRET_ASSIGNMENT_PATTERN, input) ||
    patternMatches(BEARER_TOKEN_PATTERN, input) ||
    patternMatches(COMMON_SECRET_PATTERN, input) ||
    patternMatches(EMAIL_PATTERN, input) ||
    patternMatches(PHONE_PATTERN, input) ||
    patternMatches(ID_CARD_PATTERN, input) ||
    patternMatches(WINDOWS_LOCAL_PATH_PATTERN, input) ||
    patternMatches(UNIX_LOCAL_PATH_PATTERN, input)
  )
}

export function sanitizeWebSearchQuery(input: string): string {
  return input
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(COMMON_SECRET_PATTERN, '[REDACTED_SECRET]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(PHONE_PATTERN, '[REDACTED_PHONE]')
    .replace(ID_CARD_PATTERN, '[REDACTED_ID]')
    .replace(WINDOWS_LOCAL_PATH_PATTERN, '[LOCAL_PATH]')
    .replace(UNIX_LOCAL_PATH_PATTERN, '[LOCAL_PATH]')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * High-confidence first-pass routing for real-time web search.
 *
 * "uncertain" intentionally delegates nuanced cases such as recommendations
 * to the model-based intent rewriter instead of forcing a brittle keyword rule.
 */
export function classifyRealtimeSearchIntent(input: string): RealtimeSearchIntent {
  const text = input.trim()
  if (!text) return 'not_needed'

  const isExplicitSearch = EXPLICIT_SEARCH_PATTERN.test(text)

  if (containsSensitiveSearchContent(text) && !isExplicitSearch) {
    return 'not_needed'
  }

  if (URL_PATTERN.test(text) || isExplicitSearch) {
    return 'required'
  }

  if (SUPPLIED_CONTENT_TASK_PATTERN.test(text) || TRANSFORMATION_TASK_PATTERN.test(text)) {
    return 'not_needed'
  }

  if (PERSONAL_CONVERSATION_PATTERN.test(text)) {
    return 'not_needed'
  }

  if (STABLE_EXPLANATION_PATTERN.test(text) && !RECENCY_PATTERN.test(text)) {
    return 'not_needed'
  }

  if (CREATIVE_TASK_PATTERN.test(text) && !RECENCY_PATTERN.test(text)) {
    return 'not_needed'
  }

  if (INHERENTLY_LIVE_PATTERN.test(text)) {
    return 'required'
  }

  if (
    RECENCY_PATTERN.test(text) &&
    (CHANGEABLE_FACT_PATTERN.test(text) ||
      DYNAMIC_INFORMATION_PATTERN.test(text) ||
      INFORMATION_REQUEST_PATTERN.test(text) ||
      CURRENT_BENEFIT_PATTERN.test(text))
  ) {
    return 'required'
  }

  if (GREETING_PATTERN.test(text) || CREATIVE_TASK_PATTERN.test(text)) {
    return 'not_needed'
  }

  if (
    RECENCY_PATTERN.test(text) ||
    CHANGEABLE_FACT_PATTERN.test(text) ||
    DYNAMIC_INFORMATION_PATTERN.test(text) ||
    CURRENT_BENEFIT_PATTERN.test(text)
  ) {
    return 'uncertain'
  }

  return 'not_needed'
}
