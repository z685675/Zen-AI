import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import ReactMarkdown from 'react-markdown'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import Link from '../Link'
import { markdownUrlTransform } from '../markdownUrlTransform'

const mocks = vi.hoisted(() => ({
  parseJSON: vi.fn(),
  findCitationInChildren: vi.fn(),
  CitationTooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="citation-tooltip">{children}</div>
  ),
  CitationSchema: {
    safeParse: vi.fn((input: any) => ({ success: !!input, data: input }))
  },
  Hyperlink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <div data-testid="hyperlink" data-href={href}>
      {children}
    </div>
  )
}))

vi.mock('@renderer/utils/json', () => ({
  parseJSON: mocks.parseJSON
}))

vi.mock('@renderer/utils/markdown', () => ({
  findCitationInChildren: mocks.findCitationInChildren
}))

vi.mock('../CitationTooltip', () => ({
  default: mocks.CitationTooltip,
  CitationSchema: mocks.CitationSchema
}))

vi.mock('../Hyperlink', () => ({
  default: mocks.Hyperlink
}))

describe('Link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens all three generated Windows file links through file IPC after actual Markdown rendering', async () => {
    const paths = ['report.md', 'sources.json', 'source-matrix.json'].map((name) => `D:/working/ZenAI/${name}`)
    const checkPaths = vi.fn(async () => [{ status: 'available' }])
    const openPath = vi.fn(async () => undefined)
    const original = window.api.file
    Object.assign(window.api, { file: { checkPaths, openPath } })
    try {
      render(
        <ReactMarkdown urlTransform={markdownUrlTransform} components={{ a: Link }}>
          {paths.map((path) => `[${path.split('/').at(-1)}](${path})`).join('\n\n')}
        </ReactMarkdown>
      )
      for (const path of paths) {
        const link = screen.getByRole('link', { name: path.split('/').at(-1) })
        expect(link.getAttribute('href')).toBe(path)
        fireEvent.click(link)
        await waitFor(() => expect(openPath).toHaveBeenCalledWith(path))
      }
      expect(checkPaths).toHaveBeenCalledTimes(3)
      expect(screen.queryByTestId('hyperlink')).toBeNull()
    } finally {
      Object.assign(window.api, { file: original })
    }
  })

  it('gives feedback for missing files and failed application associations without navigating the browser', async () => {
    const checkPaths = vi.fn().mockResolvedValue([{ status: 'missing' }])
    const openPath = vi.fn().mockRejectedValue(new Error('No associated application'))
    const original = window.api.file
    const originalToast = window.toast
    const toast = vi.fn()
    Object.assign(window, { toast: { error: toast } })
    Object.assign(window.api, { file: { checkPaths, openPath } })
    try {
      render(<Link href="file:///C:/Reports/report.md">Report</Link>)
      fireEvent.click(screen.getByRole('link'))
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(1))
      expect(openPath).not.toHaveBeenCalled()
      checkPaths.mockResolvedValue([{ status: 'available' }])
      fireEvent.click(screen.getByRole('link'))
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(2))
    } finally {
      Object.assign(window.api, { file: original })
      Object.assign(window, { toast: originalToast })
    }
  })

  it('should match snapshot', () => {
    const { container } = render(<Link href="https://example.com">Example</Link>)
    expect(container).toMatchSnapshot()
  })

  it('should render internal anchor as span.link and no <a>', () => {
    const { container } = render(<Link href="#section-1">Go to section</Link>)
    expect(container.querySelector('span.link')).not.toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(screen.getByText('Go to section')).toBeInTheDocument()
  })

  it('should wrap with CitationTooltip when children include <sup> and citation data exists', () => {
    mocks.findCitationInChildren.mockReturnValue('{"title":"ref"}')
    mocks.parseJSON.mockReturnValue({ title: 'ref' })

    const onParentClick = vi.fn()
    const { container } = render(
      <div onClick={onParentClick}>
        <Link href="https://example.com">
          <span>ref</span>
          <sup>1</sup>
        </Link>
      </div>
    )

    expect(screen.getByTestId('citation-tooltip')).toBeInTheDocument()

    const anchor = container.querySelector('a') as HTMLAnchorElement
    expect(anchor).not.toBeNull()
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noreferrer')

    fireEvent.click(anchor)
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('should fall back to Hyperlink when <sup> exists but citation data is null', () => {
    mocks.findCitationInChildren.mockReturnValue('{"title":"ref"}')
    mocks.parseJSON.mockReturnValue(null)

    render(
      <Link href="https://example.com">
        <span>text</span>
        <sup>1</sup>
      </Link>
    )

    expect(screen.getByTestId('hyperlink')).toBeInTheDocument()
    expect(screen.queryByTestId('citation-tooltip')).toBeNull()
  })

  it('should render normal external link inside Hyperlink when not a citation', () => {
    mocks.findCitationInChildren.mockReturnValue(undefined)
    mocks.parseJSON.mockReturnValue(undefined)

    const { container } = render(<Link href="https://domain.com/path">Open</Link>)

    const wrapper = screen.getByTestId('hyperlink')
    expect(wrapper).toBeInTheDocument()
    expect(wrapper).toHaveAttribute('data-href', 'https://domain.com/path')

    const anchor = container.querySelector('a') as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('https://domain.com/path')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noreferrer')
  })

  it('should omit empty href for citation link (no href attribute when href="")', () => {
    mocks.findCitationInChildren.mockReturnValue('{"title":"ref"}')
    mocks.parseJSON.mockReturnValue({ title: 'ref' })

    const { container } = render(
      <Link href="">
        text<sup>2</sup>
      </Link>
    )

    const anchor = container.querySelector('a') as HTMLAnchorElement
    expect(anchor).not.toBeNull()
    expect(anchor.hasAttribute('href')).toBe(false)
  })
})
