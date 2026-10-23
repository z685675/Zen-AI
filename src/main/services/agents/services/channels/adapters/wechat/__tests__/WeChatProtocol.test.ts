import { createDecipheriv, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), secure: vi.fn(() => true) }))
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
vi.mock('electron', () => ({
  net: { fetch: mocks.fetch },
  safeStorage: {
    isEncryptionAvailable: mocks.secure,
    getSelectedStorageBackend: () => 'test_secure',
    encryptString: (value: string) => Buffer.from(`protected:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^protected:/, '')
  }
}))

import { WeixinBot } from '../WeChatProtocol'

describe('new WeChat protocol boundary (mock transport only)', () => {
  let root: string
  let bot: WeixinBot
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-wechat-protocol-'))
    mocks.secure.mockReturnValue(true)
    mocks.fetch.mockReset().mockImplementation(async (url: string) => {
      if (url.includes('get_bot_qrcode')) return json({ qrcode: 'code', qrcode_img_content: 'https://example.test/qr' })
      if (url.includes('get_qrcode_status'))
        return json({
          status: 'confirmed',
          bot_token: 'secret-test-token',
          ilink_bot_id: 'account',
          ilink_user_id: 'owner',
          baseurl: 'https://ilinkai.weixin.qq.com'
        })
      if (url.includes('getuploadurl')) return json({ upload_param: 'upload-reference' })
      if (url.includes('/upload?'))
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'uploaded-reference' } })
      return json({ ret: 0 })
    })
    bot = new WeixinBot({ strict: true, tokenPath: path.join(root, 'credentials.json') })
  })
  afterEach(async () => {
    bot.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('requires secure credential storage and never writes a plain bot token', async () => {
    await bot.login({ force: true })
    const stored = JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8'))
    expect(Object.keys(stored)).toEqual(['encrypted'])
    mocks.secure.mockReturnValue(false)
    await expect(bot.login({ force: true })).rejects.toThrow('secure_storage_unavailable')
  })
  it('cancels a pending QR network request when disconnected', async () => {
    mocks.fetch.mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_, reject) => {
          options.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
    )
    const login = bot.login({ force: true })
    const rejected = expect(login).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    bot.stop()
    await rejected
  })
  it('preserves source IDs/account and refuses text delivery without an authenticated reply window', async () => {
    await bot.login({ force: true })
    await expect(bot.sendStable('owner', 'hello', 'stable-id', new AbortController().signal)).rejects.toMatchObject({
      definitelyNotSent: true
    })
    const raw = {
      message_id: 42,
      client_id: 'original-message',
      message_type: 1,
      from_user_id: 'owner',
      context_token: 'window',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
      create_time_ms: Date.now()
    }
    expect((bot as any).toIncomingMessage(raw)).toMatchObject({
      messageId: 'original-message',
      accountId: 'account',
      userId: 'owner',
      text: 'hello'
    })
    ;(bot as any).contextTokens.set('owner', 'window')
    await bot.sendStable('owner', 'hello', 'stable-id', new AbortController().signal)
    const sent = mocks.fetch.mock.calls.find(([url]) => url.includes('sendmessage'))!
    expect(JSON.parse(sent[1].body).msg).toMatchObject({
      to_user_id: 'owner',
      client_id: 'stable-id',
      context_token: 'window'
    })
  })
  it('uploads a real encrypted generic file, then submits a FILE item with stable ID and plain-byte length', async () => {
    await bot.login({ force: true })
    ;(bot as any).contextTokens.set('owner', 'window')
    const data = Buffer.from('document test')
    const onStage = vi.fn()
    await bot.sendDocument('owner', data, 'notes.docx', 'file-delivery-id', new AbortController().signal, onStage)
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['upload', 'submit'])
    const upload = mocks.fetch.mock.calls.find(([url]) => url.includes('getuploadurl'))!
    const params = JSON.parse(upload[1].body)
    expect(params).toMatchObject({
      media_type: 3,
      rawsize: data.length,
      rawfilemd5: createHash('md5').update(data).digest('hex'),
      no_need_thumb: true
    })
    const body = mocks.fetch.mock.calls.find(([url]) => url.includes('/upload?'))![1].body
    expect(body.byteLength).toBe(params.filesize)
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(params.aeskey, 'hex'), null)
    expect(Buffer.concat([decipher.update(body), decipher.final()])).toEqual(data)
    const message = JSON.parse(mocks.fetch.mock.calls.find(([url]) => url.includes('sendmessage'))![1].body).msg
    expect(message).toMatchObject({
      client_id: 'file-delivery-id',
      item_list: [
        {
          type: 4,
          file_item: {
            file_name: 'notes.docx',
            len: String(data.length),
            media: { encrypt_query_param: 'uploaded-reference' }
          }
        }
      ]
    })
  })
  it('rejects an untrusted login redirect before saving or connecting', async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.includes('get_bot_qrcode')
        ? json({ qrcode: 'code', qrcode_img_content: 'qr' })
        : json({
            status: 'confirmed',
            bot_token: 'secret',
            ilink_bot_id: 'account',
            ilink_user_id: 'owner',
            baseurl: 'http://127.0.0.1'
          })
    )
    await expect(bot.login({ force: true })).rejects.toThrow('untrusted_endpoint')
    await expect(fs.stat(path.join(root, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
