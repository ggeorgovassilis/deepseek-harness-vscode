import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import { createAttachmentRequestHandler } from './attachment-request-handler.js'

const native = vi.hoisted(() => ({
  pick: vi.fn(),
  stat: vi.fn(),
  read: vi.fn(),
  parse: vi.fn(),
  folder: vi.fn(),
}))
vi.mock('vscode', () => ({
  window: { showOpenDialog: native.pick },
  workspace: {
    fs: { stat: native.stat, readFile: native.read },
    getWorkspaceFolder: native.folder,
  },
  Uri: { parse: native.parse },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
}))

const WORKSPACE_ROOT = 'file:///fixture'

/**
 * Minimal URI stand-in: `path` keeps the on-wire path so the handler's name
 * derivation and workspace scoping are exercised, and `toString` round-trips
 * for assertions. No test depends on real VS Code URI parsing.
 */
function fakeUri(raw: string): { raw: string; scheme: string; path: string; fsPath: string } {
  const scheme = raw.slice(0, raw.indexOf(':'))
  const path = raw.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/u, '')
  return { raw, scheme, path, fsPath: path }
}

function dropFixture(): {
  readonly remember: Mock<(input: unknown) => unknown>
  readonly drop: (uris: readonly string[], signal?: AbortSignal) => Promise<unknown>
} {
  const remember = vi.fn((input: unknown) => input)
  const handler = createAttachmentRequestHandler({
    attachmentTokens: { remember },
    backendService: { requireBackend: () => ({ sessions: { supportsFileUploads: true } }) },
  } as unknown as RequestGatewayDependencies)
  return {
    remember,
    drop: (uris, signal = new AbortController().signal) =>
      handler({ type: 'attachment.drop.attach', requestId: 'drop', payload: { uris: [...uris] } }, signal),
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  native.parse.mockImplementation(fakeUri)
  native.folder.mockImplementation((uri: { raw: string }) =>
    uri.raw.startsWith(`${WORKSPACE_ROOT}/`) ? { uri } : undefined,
  )
})

function fixture(): {
  readonly remember: Mock<(input: unknown) => unknown>
  readonly pick: (signal?: AbortSignal) => Promise<unknown>
} {
  const remember = vi.fn((input: unknown) => input)
  const handler = createAttachmentRequestHandler({
    attachmentTokens: { remember },
    backendService: { requireBackend: () => ({ sessions: { supportsFileUploads: true } }) },
  } as unknown as RequestGatewayDependencies)
  return {
    remember,
    pick: (signal = new AbortController().signal) =>
      handler({ type: 'attachment.pick', requestId: 'pick' }, signal),
  }
}

describe('native attachment picking across workspace and client filesystems', () => {
  it.each(['file', 'vscode-remote', 'vscode-local'])(
    'reads the selected %s URI through its provider without exposing its authority or path',
    async (scheme) => {
      const selected = {
        scheme,
        authority: 'fixture-host',
        path: '/fixture/note.txt',
        fsPath: '/wrong-side/note.txt',
      }
      native.pick.mockResolvedValue([selected])
      native.stat.mockResolvedValue({ type: 1, size: 7 })
      native.read.mockResolvedValue(new TextEncoder().encode('fixture'))
      const f = fixture()
      expect(await f.pick()).toEqual({
        cancelled: false,
        attachment: {
          name: 'note.txt',
          mimeType: 'text/plain',
          dataUri: 'data:text/plain;base64,Zml4dHVyZQ==',
        },
      })
      expect(native.stat).toHaveBeenCalledExactlyOnceWith(selected)
      expect(native.read).toHaveBeenCalledExactlyOnceWith(selected)
    },
  )
  it('does not retain bytes when cancellation arrives during a provider read', async () => {
    const controller = new AbortController()
    native.pick.mockResolvedValue([{ scheme: 'vscode-local', path: '/fixture/note.txt' }])
    native.stat.mockResolvedValue({ type: 1, size: 7 })
    native.read.mockImplementation(() => {
      controller.abort()
      return Promise.resolve(new TextEncoder().encode('fixture'))
    })
    const f = fixture()
    await expect(f.pick(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.remember).not.toHaveBeenCalled()
  })
  it.each([
    { type: 2, size: 7 },
    { type: 65, size: 7 },
    { type: 1, size: 64 * 1024 * 1024 },
  ])('rejects an invalid selected resource before reading it (%j)', async (stat) => {
    native.pick.mockResolvedValue([{ scheme: 'vscode-local', path: '/fixture/note.txt' }])
    native.stat.mockResolvedValue(stat)
    await expect(fixture().pick()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(native.read).not.toHaveBeenCalled()
  })
})

describe('dropped workbench resources', () => {
  const note = 'file:///fixture/notes/note.txt'

  it('attaches a regular file inside an open workspace folder through its provider', async () => {
    native.stat.mockResolvedValue({ type: 1, size: 7 })
    native.read.mockResolvedValue(new TextEncoder().encode('fixture'))
    expect(await dropFixture().drop([note])).toEqual({
      cancelled: false,
      rejected: 0,
      attachments: [
        { name: 'note.txt', mimeType: 'text/plain', dataUri: 'data:text/plain;base64,Zml4dHVyZQ==' },
      ],
    })
    expect(native.stat).toHaveBeenCalledExactlyOnceWith(fakeUri(note))
    expect(native.read).toHaveBeenCalledExactlyOnceWith(fakeUri(note))
  })

  it('refuses a URI outside every open workspace folder without touching the filesystem', async () => {
    expect(await dropFixture().drop(['file:///elsewhere/secret.env'])).toEqual({
      cancelled: true,
      rejected: 1,
    })
    expect(native.stat).not.toHaveBeenCalled()
    expect(native.read).not.toHaveBeenCalled()
  })

  it('refuses an unparsable drag payload instead of guessing a path', async () => {
    native.parse.mockImplementationOnce(() => {
      throw new Error('malformed')
    })
    expect(await dropFixture().drop(['::::'])).toEqual({ cancelled: true, rejected: 1 })
    expect(native.stat).not.toHaveBeenCalled()
  })

  it.each([
    { type: 2, size: 7 },
    { type: 65, size: 7 },
  ])('refuses a dropped resource that is not a regular file (%j)', async (stat) => {
    native.stat.mockResolvedValue(stat)
    expect(await dropFixture().drop([note])).toEqual({ cancelled: true, rejected: 1 })
    expect(native.read).not.toHaveBeenCalled()
  })

  it('attaches a repeated resource once and reports the files it refused', async () => {
    native.stat.mockResolvedValue({ type: 1, size: 7 })
    native.read.mockResolvedValue(new TextEncoder().encode('fixture'))
    const result = (await dropFixture().drop([note, note, 'file:///outside/secret.env'])) as {
      attachments: unknown[]
      rejected: number
    }
    expect(result.attachments).toHaveLength(1)
    expect(result.rejected).toBe(1)
    expect(native.read).toHaveBeenCalledTimes(1)
  })

  it('does not attach bytes when cancellation arrives during the provider read', async () => {
    const controller = new AbortController()
    native.stat.mockResolvedValue({ type: 1, size: 7 })
    native.read.mockImplementation(() => {
      controller.abort()
      return Promise.resolve(new TextEncoder().encode('fixture'))
    })
    const f = dropFixture()
    await expect(f.drop([note], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.remember).not.toHaveBeenCalled()
  })

  it('surfaces the codec refusal when the only dropped file cannot be attached', async () => {
    native.stat.mockResolvedValue({ type: 1, size: 9 })
    native.read.mockResolvedValue(new TextEncoder().encode('not-a-png'))
    const f = dropFixture()
    await expect(f.drop(['file:///fixture/notes/screen.png'])).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(f.remember).not.toHaveBeenCalled()
  })

  it('names the reason a single dropped file cannot be attached', async () => {
    native.stat.mockResolvedValue({ type: 1, size: 0 })
    native.read.mockResolvedValue(new Uint8Array())
    await expect(dropFixture().drop([note])).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: 'The dropped file is empty.',
    })
  })

  it('refuses an oversized dropped file before reading it', async () => {
    native.stat.mockResolvedValue({ type: 1, size: 64 * 1024 * 1024 })
    await expect(dropFixture().drop([note])).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(native.read).not.toHaveBeenCalled()
  })

  it('reads only the files that still fit the per-message attachment budget', async () => {
    const eightMiB = 8 * 1024 * 1024
    native.stat.mockResolvedValue({ type: 1, size: eightMiB })
    native.read.mockResolvedValue(new TextEncoder().encode('fixture'))
    const uris = Array.from({ length: 30 }, (_, index) => `file:///fixture/notes/${index}.txt`)
    const result = (await dropFixture().drop(uris)) as { attachments: unknown[]; rejected: number }
    // 25 × 8 MiB is the whole 200 MiB message budget; the rest is refused
    // without another read.
    expect(result.attachments).toHaveLength(25)
    expect(result.rejected).toBe(5)
    expect(native.read).toHaveBeenCalledTimes(25)
  })
})
