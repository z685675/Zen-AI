import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import EmojiIcon from '../EmojiIcon'

describe('EmojiIcon', () => {
  it('renders the provided emoji', () => {
    const emoji = '\u{1F600}'
    const { container } = render(<EmojiIcon emoji={emoji} />)

    expect(container.textContent).toContain(emoji)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('falls back to the default background emoji when empty', () => {
    const { container } = render(<EmojiIcon emoji="" />)

    expect(container.textContent?.length).toBeGreaterThan(0)
  })

  it('applies custom styles and class name', () => {
    const { container } = render(
      <EmojiIcon emoji={'\u{1F3AF}'} size={40} fontSize={24} className="custom-emoji" />
    )
    const root = container.firstChild as HTMLElement

    expect(root).toHaveClass('custom-emoji')
    expect(root).toHaveStyle({ width: '40px', height: '40px', fontSize: '24px' })
  })
})
