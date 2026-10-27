export function clickTargetScript(snapshotId: string, ref: number, expectedText?: string) {
  return `(() => {
    const snapshot = globalThis.__zenBrowserSnapshot;
    if (!snapshot || snapshot.id !== ${JSON.stringify(snapshotId)} || snapshot.url !== location.href)
      throw new Error('Snapshot expired; take a new snapshot before clicking.');
    const node = snapshot.elements.get(${ref});
    if (!node || !node.isConnected) throw new Error('Element is stale; take a new snapshot.');
    const text = (node.textContent || node.value || '').trim();
    if (node.disabled || node.closest('[inert]') || node.getAttribute('aria-disabled') === 'true')
      throw new Error('Element is disabled.');
    node.scrollIntoView({ block: 'center', inline: 'center' });
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none')
      throw new Error('Element is not visible.');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !node.contains(hit)) throw new Error('Element is covered; inspect the page before clicking.');
    if (${JSON.stringify(expectedText ?? '')} && text.includes(${JSON.stringify(expectedText ?? '')}))
      return { alreadySatisfied: true, text };
    return { x, y, text };
  })()`
}

export function clickVerificationScript(snapshotId: string, ref: number, expectedText: string, timeoutMs: number) {
  return `(async () => {
    const started = Date.now();
    let text = '';
    do {
      const snapshot = globalThis.__zenBrowserSnapshot;
      const node = snapshot && snapshot.id === ${JSON.stringify(snapshotId)} && snapshot.url === location.href
        ? snapshot.elements.get(${ref}) : null;
      if (!node || !node.isConnected) return { verified: false, reason: 'page-or-element-changed' };
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none')
        return { verified: false, reason: 'element-not-visible' };
      text = (node.textContent || node.value || '').trim();
      if (text.includes(${JSON.stringify(expectedText)})) return { verified: true, text };
      if (Date.now() - started >= ${timeoutMs}) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (true);
    return { verified: false, text, reason: 'expected-text-not-observed' };
  })()`
}
