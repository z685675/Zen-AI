import * as z from 'zod'

import type { CdpBrowserController } from '../controller'
import { logger } from '../types'
import { errorResponse, successResponse } from './utils'

export const SnapshotSchema = z.object({
  selector: z
    .string()
    .optional()
    .describe('CSS selector to scope the snapshot (e.g. "#search" for search results only)'),
  maxChars: z.number().optional().describe('Maximum characters to return (truncates with notice if exceeded)'),
  privateMode: z.boolean().optional().describe('Target private session (default: false)'),
  tabId: z.string().optional().describe('Target specific tab by ID')
})

const DEFAULT_SNAPSHOT_MAX_CHARS = 12_000
const MIN_SNAPSHOT_MAX_CHARS = 1_000
const MAX_SNAPSHOT_MAX_CHARS = 16_000
const MAX_SNAPSHOT_SOURCE_CHARS = 200_000

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SNAPSHOT_MAX_CHARS
  }
  return Math.min(MAX_SNAPSHOT_MAX_CHARS, Math.max(MIN_SNAPSHOT_MAX_CHARS, Math.floor(value)))
}

// Script that walks the DOM and produces an AI-friendly text snapshot with numbered refs for interactive elements
const SNAPSHOT_SCRIPT = `(() => {
  const out = [];
  let n = 0;
  let outputChars = 0;
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','PATH','META','LINK','BR','HR']);

  function append(value) {
    if (outputChars >= ${MAX_SNAPSHOT_SOURCE_CHARS}) return;
    const text = String(value);
    const remaining = ${MAX_SNAPSHOT_SOURCE_CHARS} - outputChars;
    out.push(text.slice(0, remaining));
    outputChars += Math.min(text.length, remaining);
  }

  function vis(e) {
    if (!e.getBoundingClientRect) return false;
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function walk(node) {
    if (outputChars >= ${MAX_SNAPSHOT_SOURCE_CHARS}) return;
    if (node.nodeType === 3) {
      const t = node.textContent.trim();
      if (t) append(t);
      return;
    }
    if (node.nodeType !== 1) return;
    if (skip.has(node.tagName)) return;
    if (!vis(node)) return;

    const tag = node.tagName;
    const r = ++n;

    if (tag === 'A' && node.href) {
      const t = node.textContent.trim();
      if (t) append('[' + r + '] link: ' + t + ' (' + node.href + ')');
      return;
    }
    if (tag === 'BUTTON' || (tag === 'INPUT' && (node.type === 'submit' || node.type === 'button'))) {
      append('[' + r + '] button: ' + (node.textContent.trim() || node.value || ''));
      return;
    }
    if (tag === 'INPUT') {
      if (node.type === 'hidden') return;
      append('[' + r + '] input(' + (node.type || 'text') + '): ' + (node.name || node.placeholder || ''));
      return;
    }
    if (tag === 'TEXTAREA') {
      append('[' + r + '] textarea: ' + (node.name || node.placeholder || ''));
      return;
    }
    if (tag === 'SELECT') {
      const sel = node.options && node.options[node.selectedIndex];
      append('[' + r + '] select: ' + (sel ? sel.text : node.name || ''));
      return;
    }
    if (tag === 'IMG' && node.alt) {
      append('[' + r + '] img: ' + node.alt);
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      const level = tag[1];
      append('\\n' + '#'.repeat(+level) + ' ' + node.textContent.trim() + '\\n');
      return;
    }

    for (const c of node.childNodes) walk(c);
  }

  walk(ROOT_ELEMENT);
  return out.join('\\n');
})()`

export const snapshotToolDefinition = {
  name: 'snapshot',
  description:
    'Get an AI-friendly text snapshot of the current page with numbered refs for interactive elements. Much more compact than raw HTML/markdown. Use selector to scope to a specific part (e.g. "#search" for Google results, "#main" for article body). Keep browser snapshots within the shared two-operation concurrency limit.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector to scope the snapshot (e.g. "#search", "#main", ".results")'
      },
      maxChars: {
        type: 'number',
        description: 'Maximum characters to return (default: 12000; allowed range: 1000-16000)'
      },
      privateMode: {
        type: 'boolean',
        description: 'Target private session (default: false)'
      },
      tabId: {
        type: 'string',
        description: 'Target specific tab by ID'
      }
    }
  }
}

export async function handleSnapshot(controller: CdpBrowserController, args: unknown) {
  try {
    const { selector, maxChars, privateMode, tabId } = SnapshotSchema.parse(args)

    const rootExpr = selector
      ? `(document.querySelector(${JSON.stringify(selector)}) || document.body)`
      : 'document.body'

    const script = SNAPSHOT_SCRIPT.replace('ROOT_ELEMENT', rootExpr)

    const result = await controller.execute(script, 10000, privateMode ?? false, tabId)

    let content = typeof result === 'string' ? result : (JSON.stringify(result) ?? '')
    const normalizedMaxChars = normalizeMaxChars(maxChars)
    if (content.length > normalizedMaxChars) {
      content = content.slice(0, normalizedMaxChars) + '\n... [truncated at ' + normalizedMaxChars + ' chars]'
    }

    const userAction = await controller.waitForUserActionDetection(privateMode ?? false, tabId)
    return successResponse(userAction ? JSON.stringify({ content, userAction }) : content)
  } catch (error) {
    logger.error('Snapshot failed', { error })
    return errorResponse(error instanceof Error ? error : String(error))
  }
}
