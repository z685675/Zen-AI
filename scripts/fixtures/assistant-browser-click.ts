import assert from 'node:assert/strict'

import { app } from 'electron'

import { CdpBrowserController } from '../../src/main/mcpServers/browser/controller'
import { handleClick } from '../../src/main/mcpServers/browser/tools/click'
import { handleSnapshot } from '../../src/main/mcpServers/browser/tools/snapshot'

app.setPath('userData', process.env.BROWSER_CLICK_SMOKE_DATA!)
async function main() {
  await app.whenReady()
  const controller = new CdpBrowserController()
  try {
    const page = `<html><body><button id="follow">Follow</button><button id="nochange">No change</button><button id="disabled" disabled>Disabled</button><script>
      window.clicks = 0; window.trusted = false;
      document.querySelector('#follow').onclick = event => { window.clicks++; window.trusted = event.isTrusted; setTimeout(() => { document.querySelector('#follow').textContent = 'Following' }, 100) };
      document.querySelector('#nochange').onclick = () => { window.clicks++ };
    </script></body></html>`
    const { tabId } = await controller.open('data:text/html;charset=utf-8,' + encodeURIComponent(page))
    const snapshot = await handleSnapshot(controller, { tabId })
    const text = snapshot.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
    const snapshotId = /Snapshot ID: ([a-f0-9-]+)/.exec(text)?.[1]
    const ref = Number(/\[(\d+)\] button: Follow\n/.exec(text)?.[1])
    assert.ok(snapshotId && ref)
    const started = performance.now()
    const result = await handleClick(controller, { tabId, snapshotId, ref, expectedText: 'Following' })
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    assert.equal(payload.clicked, true)
    assert.equal(payload.verified, true)
    assert.deepEqual(
      await controller.execute('({ clicks: window.clicks, trusted: window.trusted })', 5000, false, tabId),
      { clicks: 1, trusted: true }
    )
    const again = await controller.click(snapshotId, ref, 'Following', 1000, false, tabId)
    assert.equal(again.clicked, false)
    await controller.execute('document.querySelector("#follow").style.display = "none"', 5000, false, tabId)
    await assert.rejects(controller.click(snapshotId, ref, 'Following', 200, false, tabId), /not visible/)
    await controller.execute('document.querySelector("#follow").style.display = ""', 5000, false, tabId)
    const unchangedRef = Number(/\[(\d+)\] button: No change/.exec(text)?.[1])
    const duplicates = await Promise.all([
      controller.click(snapshotId, unchangedRef, 'Done', 200, false, tabId),
      controller.click(snapshotId, unchangedRef, 'Done', 200, false, tabId)
    ])
    assert.equal(duplicates.filter((result) => result.clicked === true).length, 1)
    const unchanged = duplicates.find((result) => result.clicked === true)!
    assert.equal(unchanged.clicked, true)
    assert.equal(unchanged.verified, false)
    assert.equal(await controller.execute('window.clicks', 5000, false, tabId), 2)
    const repeated = await controller.click(snapshotId, unchangedRef, 'Done', 200, false, tabId)
    assert.equal(repeated.clicked, false)
    assert.equal(repeated.verified, false)
    const disabledRef = Number(/\[(\d+)\] button: Disabled/.exec(text)?.[1])
    await assert.rejects(controller.click(snapshotId, disabledRef, undefined, 200, false, tabId), /disabled/)
    await handleSnapshot(controller, { tabId })
    await assert.rejects(controller.click(snapshotId, ref, undefined, 200, false, tabId), /expired/)
    assert.equal(await controller.execute('window.clicks', 5000, false, tabId), 2)
    process.stdout.write(
      JSON.stringify({
        status: 'passed',
        trustedInput: true,
        noBlindRetry: true,
        staleAndDisabledRejected: true,
        elapsedMs: Math.round(performance.now() - started)
      }) + '\n'
    )
  } finally {
    await controller.dispose()
    app.quit()
  }
}
void main().catch((error) => {
  process.stderr.write(String(error) + '\n')
  app.exit(1)
})
