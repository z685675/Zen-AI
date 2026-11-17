import path from 'node:path'

import { DIAGNOSTIC_OPERATION_HEADER, DIAGNOSTIC_TRACE_HEADER } from '@shared/diagnostics'
import { MODEL_TRANSPORT_IPC, type ModelTransportRequest } from '@shared/modelTransport'
import { app, ipcMain, net, session } from 'electron'

import { getClientConnectionRouter } from '../ClientConnectionService'
import { recordMainDiagnostic } from '../DiagnosticEvidenceService'
import { trustedHotpatchFrame } from '../hotpatch/security'
import { installClientConnectionRouter } from './apiFetch'
import { ModelTransportBroker } from './broker'
import { modelApiTransport } from './transport'

export function registerModelTransportIpc() {
  modelApiTransport.resolveProxy = (url) => session.defaultSession.resolveProxy(url)
  const routes = getClientConnectionRouter()
  installClientConnectionRouter(routes)
  modelApiTransport.route = (input, init, send, record) => routes.fetch(input, init, send, record)
  void routes.refresh()
  const refresh = setInterval(() => void routes.refresh(), 60_000)
  refresh.unref()
  const broker = new ModelTransportBroker((request, signal) => {
    const headers = new Headers(request.headers)
    const id = headers.get(DIAGNOSTIC_OPERATION_HEADER) || undefined
    const traceId = headers.get(DIAGNOSTIC_TRACE_HEADER)
    return modelApiTransport.fetch(
      request.url,
      {
        method: request.method,
        headers,
        body: request.body,
        signal,
        credentials: 'omit',
        redirect: 'manual'
      },
      (event, details) => recordMainDiagnostic(id, 'transport', event, { traceId, ...details }),
      (input, init) => net.fetch(input instanceof URL ? input.href : input, init)
    )
  })
  const owners = new WeakSet<Electron.WebContents>()
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    const expected = process.env.ELECTRON_RENDERER_URL
    const actual = event.senderFrame?.url.split(/[?#]/)[0].replace(/\/$/, '')
    const developmentFrame =
      !app.isPackaged &&
      !!expected &&
      [
        expected.replace(/\/$/, ''),
        ...['index.html', 'miniWindow.html', 'selectionAction.html'].map(
          (entry) => `${expected.replace(/\/$/, '')}/${entry}`
        )
      ].includes(actual || '')
    if (
      event.sender.isDestroyed() ||
      event.sender.session !== session.defaultSession ||
      event.senderFrame !== event.sender.mainFrame ||
      !(developmentFrame || trustedHotpatchFrame(event, path.resolve(__dirname, '../renderer')))
    )
      throw new Error('Invalid model transport sender')
    if (!owners.has(event.sender)) {
      owners.add(event.sender)
      const cancel = () => broker.cancelOwner(event.sender.id)
      event.sender.once('destroyed', cancel)
      event.sender.on('render-process-gone', cancel)
      event.sender.on('did-navigate', cancel)
    }
    return event.sender.id
  }
  ipcMain.handle(MODEL_TRANSPORT_IPC.start, (event, request: ModelTransportRequest) =>
    broker.start(guard(event), request)
  )
  ipcMain.handle(MODEL_TRANSPORT_IPC.pull, (event, id: string) => broker.pull(guard(event), id))
  ipcMain.handle(MODEL_TRANSPORT_IPC.cancel, (event, id: string) => broker.cancel(guard(event), id))
  app.once('will-quit', () => {
    clearInterval(refresh)
    broker.stop()
    void modelApiTransport.destroy()
  })
}
