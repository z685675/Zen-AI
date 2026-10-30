import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const workflow = YAML.parse(
  readFileSync(fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url)), 'utf8')
)

describe('installer build and public update boundary', () => {
  it('keeps version tag builds in draft until an explicit manual publication', () => {
    expect(workflow.on.push.tags).toContain('v*.*.*')
    expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false)
    const gate = workflow.jobs.publish.if
    // A tag push cannot satisfy the first term; false/default input cannot satisfy the second.
    expect(gate).toBe("github.event_name == 'workflow_dispatch' && inputs.publish && inputs.platform == 'all'")
    expect(workflow.jobs['sync-downloads'].needs).toBe('publish')
    expect(workflow.jobs['sync-downloads'].if).toBe("needs.publish.outputs.published == 'true'")
  })

  it('uploads both Windows and macOS installers as drafts without changing latest', () => {
    const uploads = workflow.jobs.release.steps.filter((step: { uses?: string }) =>
      step.uses?.startsWith('ncipollo/release-action@')
    )
    expect(uploads).toHaveLength(2)
    for (const step of uploads) {
      expect(step.with.draft).toBe(true)
      expect(step.with.makeLatest).toBe(false)
    }
  })
})
