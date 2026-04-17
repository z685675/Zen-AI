import { loggerService } from '@logger'
import { convertSpanToSpanEntity, FunctionSpanExporter, FunctionSpanProcessor } from '@mcp-trace/trace-core'
import { WebTracer } from '@mcp-trace/trace-web'
import { trace } from '@opentelemetry/api'
import { APP_NAME } from '@shared/config/constant'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

const logger = loggerService.withContext('WebTraceService')

const TRACER_NAME = APP_NAME.replace(/\s+/g, '')

class WebTraceService {
  init() {
    const exporter = new FunctionSpanExporter((spans: ReadableSpan[]): Promise<void> => {
      // Implement your save logic here if needed
      // For now, just resolve immediately
      logger.info(`Saving spans: ${spans.length}`)
      return Promise.resolve()
    })

    const processor = new FunctionSpanProcessor(
      exporter,
      (span: ReadableSpan) => {
        void window.api.trace.saveEntity(convertSpanToSpanEntity(span))
      },
      (span: ReadableSpan) => {
        void window.api.trace.saveEntity(convertSpanToSpanEntity(span))
      }
    )
    WebTracer.init(
      {
        defaultTracerName: TRACER_NAME,
        serviceName: TRACER_NAME
      },
      processor
    )
  }

  getTracer() {
    return trace.getTracer(TRACER_NAME, '1.0.0')
  }
}

export const webTraceService = new WebTraceService()
