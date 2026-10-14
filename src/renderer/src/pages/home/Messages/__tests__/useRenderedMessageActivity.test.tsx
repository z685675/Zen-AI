import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { hasRenderedMessageActivity, useRenderedMessageActivity } from '../useRenderedMessageActivity'

function Reply({ id = 'reply', text = '', opacity = 1, enabled = true }) {
  const ref = useRef<HTMLDivElement>(null)
  const rendered = useRenderedMessageActivity(ref, id, enabled)
  return (
    <>
      <div ref={ref} data-testid="content">
        <div style={{ opacity }}>
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      </div>
      <output data-testid="rendered">{String(rendered)}</output>
    </>
  )
}
const mutations = async () =>
  act(async () => {
    await Promise.resolve()
  })
const expectRendered = (value: boolean) => expect(screen.getByTestId('rendered')).toHaveTextContent(String(value))

afterEach(() => vi.restoreAllMocks())

describe('actual rendered reply acknowledgement', () => {
  it('keeps waiting for a Markdown prefix with no visible characters, then acknowledges the first rendered text', async () => {
    const { rerender } = render(<Reply />)
    expectRendered(false)
    rerender(<Reply text="#" />)
    await mutations()
    expect(screen.getByTestId('content').textContent).toBe('')
    expectRendered(false)
    rerender(<Reply text="# 首字" />)
    await mutations()
    expect(screen.getByText('首字')).toBeVisible()
    expectRendered(true)
  })

  it('does not acknowledge a transparent entrance-animation frame', async () => {
    const { rerender } = render(<Reply text="真正的回答" opacity={0} />)
    expectRendered(false)
    rerender(<Reply text="真正的回答" opacity={1} />)
    await mutations()
    expectRendered(true)
  })

  it('stays acknowledged across later model/tool waits, but resets for a new reply', async () => {
    const { rerender } = render(<Reply text="已显示的工具结果" />)
    expectRendered(true)
    rerender(<Reply text="" />)
    await mutations()
    expectRendered(true)
    rerender(<Reply id="next-reply" />)
    expectRendered(false)
    rerender(<Reply id="next-reply" text="下一轮首字" />)
    await mutations()
    expectRendered(true)
  })

  it('acknowledges restored content immediately, without waiting for another token', () => {
    render(<Reply text="切回会话时已经存在的文件卡片" />)
    expectRendered(true)
  })

  it('ignores whitespace, styles, hidden regions and decorative icons', () => {
    const root = document.createElement('div')
    document.body.append(root)
    root.innerHTML =
      '<style>.sample { color: red }</style><p> \n </p><span hidden>隐藏内容</span><div style="display:none">隐藏工具</div><svg aria-hidden="true"><title>图标</title></svg>'
    expect(hasRenderedMessageActivity(root)).toBe(false)
    root.append(document.createTextNode('可见的工具名称'))
    expect(hasRenderedMessageActivity(root)).toBe(true)
    root.remove()
  })

  it('acknowledges a media-only response on load, not when its empty image is mounted', async () => {
    const ref = { current: document.createElement('div') }
    document.body.append(ref.current)
    const image = document.createElement('img')
    ref.current.append(image)
    Object.defineProperty(image, 'complete', { configurable: true, value: false })
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 0 })
    function Media() {
      const rendered = useRenderedMessageActivity(ref, 'media', true)
      return <output data-testid="rendered">{String(rendered)}</output>
    }
    const { unmount } = render(<Media />)
    expectRendered(false)
    Object.defineProperty(image, 'complete', { configurable: true, value: true })
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 400 })
    act(() => {
      image.dispatchEvent(new Event('load'))
    })
    expectRendered(true)
    unmount()
    ref.current.remove()
  })

  it('does not observe old/finished messages and disconnects when the live reply unmounts', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const { rerender, unmount } = render(<Reply enabled={false} />)
    expect(observe).not.toHaveBeenCalled()
    rerender(<Reply />)
    expect(observe).toHaveBeenCalledOnce()
    unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
