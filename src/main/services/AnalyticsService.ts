import { loggerService } from '@logger'
import type { TokenUsageData } from '@cherrystudio/analytics-client'

const logger = loggerService.withContext('AnalyticsService')

class AnalyticsService {
  private static instance: AnalyticsService

  public static getInstance(): AnalyticsService {
    if (!AnalyticsService.instance) {
      AnalyticsService.instance = new AnalyticsService()
    }
    return AnalyticsService.instance
  }

  public init(): void {
    logger.info('Analytics service disabled for this distribution build')
  }

  public trackTokenUsage(_data: TokenUsageData): void {
    return
  }

  public async trackAppUpdate(): Promise<void> {
    return
  }

  public async destroy(): Promise<void> {
    logger.info('Analytics service disabled, nothing to destroy')
  }
}

export const analyticsService = AnalyticsService.getInstance()
