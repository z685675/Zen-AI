import { type RefObject, useLayoutEffect, useState } from 'react'

/** Ignore raw Markdown, hidden text and animation frames that are still transparent. */
export function hasRenderedMessageActivity(root: HTMLElement): boolean {
  const styles = new Map<HTMLElement, CSSStyleDeclaration>()
  const visible = (element: HTMLElement): boolean => {
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      if (current.matches('style, script, template, [hidden], [aria-hidden="true"]')) return false
      const style = styles.get(current) ?? window.getComputedStyle(current)
      styles.set(current, style)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      if (current === root) return true
    }
    return false
  }
  const texts = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let text = texts.nextNode(); text; text = texts.nextNode()) {
    if (text.textContent?.trim() && text.parentElement && visible(text.parentElement)) return true
  }
  // Media-only responses have no text node. Wait for an actual image/video, not its placeholder.
  return Array.from(root.querySelectorAll<HTMLImageElement | HTMLVideoElement>('img, video')).some(
    (media) =>
      visible(media) &&
      (media instanceof HTMLImageElement ? media.complete && media.naturalWidth > 0 : media.readyState >= 2)
  )
}

/** Local, one-way acknowledgement of committed content; never use received tokens as proof of display. */
export function useRenderedMessageActivity(
  contentRef: RefObject<HTMLDivElement | null>,
  messageId: string,
  enabled: boolean
): boolean {
  const [renderedMessageId, setRenderedMessageId] = useState<string>()
  useLayoutEffect(() => {
    const root = contentRef.current
    if (!enabled || !root || renderedMessageId === messageId) return
    let active = true
    const observer = new MutationObserver(() => inspect())
    const cleanup = () => {
      observer.disconnect()
      root.removeEventListener('load', inspect, true)
      root.removeEventListener('loadeddata', inspect, true)
    }
    const inspect = () => {
      if (!active || !hasRenderedMessageActivity(root)) return
      cleanup()
      setRenderedMessageId(messageId)
    }
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
    })
    root.addEventListener('load', inspect, true)
    root.addEventListener('loadeddata', inspect, true)
    inspect()
    return () => {
      active = false
      cleanup()
    }
  }, [contentRef, enabled, messageId, renderedMessageId])
  return enabled && renderedMessageId === messageId
}
