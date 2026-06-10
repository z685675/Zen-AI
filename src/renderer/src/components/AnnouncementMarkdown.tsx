import ReactMarkdown from 'react-markdown'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import styled from 'styled-components'

type AnnouncementMarkdownProps = {
  content: string
  compact?: boolean
}

const AnnouncementMarkdown = ({ content, compact = false }: AnnouncementMarkdownProps) => {
  return (
    <MarkdownRoot className="markdown" $compact={compact}>
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkCjkFriendly]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault()
                if (href) {
                  void window.api.openWebsite(href)
                }
              }}>
              {children}
            </a>
          )
        }}>
        {content}
      </ReactMarkdown>
    </MarkdownRoot>
  )
}

const MarkdownRoot = styled.div<{ $compact: boolean }>`
  color: inherit;
  line-height: ${({ $compact }) => ($compact ? 1.55 : 1.7)};
  user-select: text;

  > *:first-child {
    margin-top: 0;
  }

  > *:last-child {
    margin-bottom: 0;
  }

  p {
    margin: ${({ $compact }) => ($compact ? '0 0 6px' : '0 0 10px')};
  }

  h1,
  h2,
  h3,
  h4 {
    margin: ${({ $compact }) => ($compact ? '10px 0 6px' : '14px 0 8px')};
    color: var(--color-text-1);
    line-height: 1.35;
  }

  h1 {
    font-size: ${({ $compact }) => ($compact ? '17px' : '20px')};
  }

  h2 {
    font-size: ${({ $compact }) => ($compact ? '16px' : '18px')};
  }

  h3,
  h4 {
    font-size: ${({ $compact }) => ($compact ? '15px' : '16px')};
  }

  ul,
  ol {
    margin: 8px 0;
    padding-left: 1.4em;
  }

  li {
    margin: 4px 0;
  }

  strong {
    color: var(--color-text-1);
    font-weight: 700;
  }

  code {
    border-radius: 5px;
    padding: 1px 5px;
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    color: var(--color-text-1);
    font-size: 0.92em;
  }

  pre {
    overflow: auto;
    border-radius: 10px;
    padding: 10px 12px;
    background: var(--color-background-mute);
  }

  pre code {
    padding: 0;
    background: transparent;
  }

  blockquote {
    margin: 10px 0;
    padding: 8px 12px;
    border-left: 3px solid var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
    color: var(--color-text-2);
  }

  a {
    color: var(--color-primary);
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0;
  }

  th,
  td {
    border: 1px solid var(--color-border);
    padding: 6px 8px;
    text-align: left;
  }
`

export default AnnouncementMarkdown
