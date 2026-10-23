import * as vscode from 'vscode'
import path from 'node:path'
import { AppError } from '@dsh-vscode/domain'
import { MAX_PROMPT_ATTACHMENT_TOTAL_BYTES, type WebviewRequest } from '@dsh-vscode/webview-protocol'
import {
  decodeCanonicalBase64,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  type StoredAttachmentInput,
} from '../attachments/attachment-store.js'
import {
  attachmentMimeType,
  attachmentSizeLimit,
  isImageMimeType,
  prepareAttachment,
  isAttachmentSupported,
  assertAttachmentSupported,
  validImageBytes,
} from '../attachments/attachment-codec.js'
import { featureContextItem, listOpenFileCandidates, readOpenFileAttachment } from './editor-files.js'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import { unsupportedRequest } from './request-routing.js'

type AttachmentRequest = Extract<WebviewRequest, { type: `attachment.${string}` }>
/** One dropped URI's resolution: bytes to keep, an exhausted batch budget, or a refusal. */
type DroppedRead =
  { readonly input: StoredAttachmentInput; readonly size: number } | 'over-budget' | undefined
type AttachmentDependencies = Pick<
  RequestGatewayDependencies,
  | 'backendService'
  | 'sessionUseCases'
  | 'attachmentTokens'
  | 'editorContextProvider'
  | 'requireCurrentWorkspaceSession'
>

export function isAttachmentRequest(request: WebviewRequest): request is AttachmentRequest {
  return request.type.startsWith('attachment.')
}

export function createAttachmentRequestHandler(
  deps: AttachmentDependencies,
): (request: AttachmentRequest, signal: AbortSignal) => Promise<unknown> {
  const {
    backendService,
    sessionUseCases,
    attachmentTokens,
    editorContextProvider,
    requireCurrentWorkspaceSession,
  } = deps

  const supportsBinaryAttachments = (): boolean => {
    try {
      return backendService.requireBackend().sessions.supportsFileUploads === true
    } catch {
      return false
    }
  }

  const rememberSupportedAttachment = (
    input: StoredAttachmentInput,
  ): ReturnType<typeof attachmentTokens.remember> => {
    assertAttachmentSupported(input, supportsBinaryAttachments())
    return attachmentTokens.remember(input)
  }

  /**
   * Resolve one URI from a workbench drag into attachment bytes.
   *
   * The Webview cannot read a dropped resource itself and never holds the
   * authority to decide what a URI means. Membership in an open workspace
   * folder is the only scope accepted here, and the bytes are read through
   * `workspace.fs` so a remote window reads on its own side instead of handing
   * a client path to a Node file API. `undefined` means "not attachable" (a
   * folder, a symlink, a missing or unreadable file) and `'over-budget'` means
   * the rest of the drop no longer fits the message; an empty, oversized,
   * malformed or unsupported file throws the codec's own `AppError`.
   */
  const readDroppedResource = async (
    raw: string,
    signal: AbortSignal,
    remainingBytes: number,
  ): Promise<DroppedRead> => {
    const uri = droppedWorkspaceUri(raw)
    if (uri === undefined) return undefined
    const name = path.posix.basename(uri.path)
    if (name === '') return undefined
    // Images and text have different budgets, and the name decides which one
    // applies before any bytes are materialized.
    const sizeLimit = attachmentSizeLimit(name)
    const info = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined)
    signal.throwIfAborted()
    if (
      info === undefined ||
      (info.type & vscode.FileType.File) === 0 ||
      (info.type & vscode.FileType.SymbolicLink) !== 0
    )
      return undefined
    if (info.size > sizeLimit) throw droppedFileTooLarge()
    // A drop is the only attachment entry point that can name many files at
    // once, so it also has to respect the per-message budget the prompt schema
    // enforces instead of materializing the whole selection first.
    if (info.size > remainingBytes) return 'over-budget'
    const read = await Promise.resolve(vscode.workspace.fs.readFile(uri)).catch(() => undefined)
    signal.throwIfAborted()
    if (read === undefined) return undefined
    const bytes = Buffer.from(read)
    if (bytes.length === 0) throw droppedFileEmpty()
    if (bytes.length > sizeLimit) throw droppedFileTooLarge()
    // A provider may understate `stat`; the bytes it returned still count
    // against what this message can carry.
    if (bytes.length > remainingBytes) return 'over-budget'
    return { input: prepareAttachment(name, bytes), size: Math.max(info.size, bytes.length) }
  }

  return async (request: AttachmentRequest, signal: AbortSignal): Promise<unknown> => {
    if (request.type === 'attachment.pick') {
      signal.throwIfAborted()
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Attach file',
      })
      const uri = selected?.[0]
      signal.throwIfAborted()
      if (uri === undefined) return { cancelled: true }
      const info = await vscode.workspace.fs.stat(uri)
      signal.throwIfAborted()
      if (
        (info.type & vscode.FileType.File) === 0 ||
        (info.type & vscode.FileType.SymbolicLink) !== 0 ||
        info.size > MAX_IMAGE_ATTACHMENT_BYTES
      )
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large or is not a regular file.',
          retryable: false,
        })
      const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri))
      signal.throwIfAborted()
      if (bytes.length > MAX_IMAGE_ATTACHMENT_BYTES)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large.',
          retryable: false,
        })
      const mimeType = attachmentMimeType(uri.path, bytes)
      if (mimeType === undefined)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file contents do not match its declared text type.',
          retryable: false,
        })
      const maximumBytes = isImageMimeType(mimeType) ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES
      if (bytes.length > maximumBytes)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large.',
          retryable: false,
        })
      if (isImageMimeType(mimeType) && !validImageBytes(mimeType, bytes))
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file contents do not match its declared image type.',
          retryable: false,
        })
      return {
        cancelled: false,
        attachment: rememberSupportedAttachment({
          name: path.posix.basename(uri.path),
          mimeType,
          dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`,
        }),
      }
    }

    if (request.type === 'attachment.ingest') {
      const { name, mimeType, dataBase64 } = request.payload
      const bytes = decodeCanonicalBase64(dataBase64, MAX_IMAGE_ATTACHMENT_BYTES)
      return {
        cancelled: false,
        attachment: rememberSupportedAttachment(prepareAttachment(name, bytes, mimeType)),
      }
    }

    if (request.type === 'attachment.drop.attach') {
      const attachments: ReturnType<typeof attachmentTokens.remember>[] = []
      const failures: AppError[] = []
      let rejected = 0
      let totalBytes = 0
      // A drag repeats the same resource across several transfer types; attach
      // each file once even if it arrives twice.
      const uris = [...new Set(request.payload.uris)]
      for (const raw of uris) {
        signal.throwIfAborted()
        let prepared: DroppedRead
        try {
          prepared = await readDroppedResource(raw, signal, MAX_PROMPT_ATTACHMENT_TOTAL_BYTES - totalBytes)
        } catch (error) {
          if (!(error instanceof AppError)) throw error
          failures.push(error)
          rejected += 1
          continue
        }
        if (prepared === 'over-budget') {
          // This file does not fit what is left of the message; keep trying the
          // smaller ones instead of abandoning the rest of the drop.
          rejected += 1
          continue
        }
        if (prepared === undefined) {
          rejected += 1
          continue
        }
        try {
          attachments.push(rememberSupportedAttachment(prepared.input))
          totalBytes += prepared.size
        } catch (error) {
          if (!(error instanceof AppError)) throw error
          failures.push(error)
          rejected += 1
        }
      }
      // Nothing attached: surface the most specific refusal the codec produced
      // (unsupported bytes, capacity) instead of an empty, silent drop.
      if (attachments.length === 0) {
        const failure = failures[0]
        if (failure !== undefined) throw failure
        return { cancelled: true, rejected }
      }
      return { cancelled: false, attachments, rejected }
    }

    if (request.type === 'attachment.preview') {
      const dataUri = attachmentTokens.preview(request.payload.uri)
      return dataUri === undefined ? { cancelled: true } : { cancelled: false, dataUri }
    }

    if (request.type === 'attachment.release') {
      attachmentTokens.releaseUris(request.payload.uris)
      return undefined
    }

    if (request.type === 'attachment.open.list') {
      const candidates = listOpenFileCandidates()
      return {
        items: candidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          ...(candidate.mimeType === undefined ? {} : { mimeType: candidate.mimeType }),
          active: candidate.active,
          supported: isAttachmentSupported(candidate.mimeType, supportsBinaryAttachments()),
        })),
      }
    }

    if (request.type === 'attachment.open.attach') {
      const candidate = listOpenFileCandidates().find((item) => item.id === request.payload.candidateId)
      if (candidate === undefined || !isAttachmentSupported(candidate.mimeType, supportsBinaryAttachments()))
        return { cancelled: true }
      const attachment = await readOpenFileAttachment(candidate)
      if (attachment === undefined) return { cancelled: true }
      if (
        candidate.uri.scheme === 'file' &&
        attachment.mimeType !== undefined &&
        attachment.mimeType !== 'application/octet-stream' &&
        !isImageMimeType(attachment.mimeType)
      ) {
        const context = await editorContextProvider
          .captureOpenFile(candidate.uri, signal)
          .catch((error: unknown) => {
            if (error instanceof AppError && error.code === 'CONTEXT_LIMIT') return undefined
            throw error
          })
        if (context !== undefined) return { kind: 'editor.context', items: [featureContextItem(context)] }
      }
      return {
        cancelled: false,
        attachment: rememberSupportedAttachment(attachment),
      }
    }

    if (request.type === 'attachment.read') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const attachment = await sessionUseCases.readAttachment(
        request.payload.sessionId,
        request.payload.attachmentId,
        signal,
      )
      return {
        cancelled: false,
        attachment: {
          name: attachment.name,
          ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
        },
        // The adapter has already validated this as a bounded image data URI.
        // It is display data, not an endpoint or credential, so historical
        // images do not need a second opaque-handle round trip.
        dataUri: attachment.uri,
      }
    }
    return unsupportedRequest(request)
  }
}

/**
 * A workbench drag payload is a URI string produced by VS Code for the resource
 * the user picked up. Only a resource inside an open workspace folder is in
 * scope: the folder check is also what keeps a crafted Webview request from
 * reading an arbitrary path, and it matches the folder identity for whichever
 * provider scheme the window is using.
 */
function droppedWorkspaceUri(raw: string): vscode.Uri | undefined {
  let uri: vscode.Uri
  try {
    uri = vscode.Uri.parse(raw, true)
  } catch {
    return undefined
  }
  if (uri.fsPath === '' && uri.path === '') return undefined
  return vscode.workspace.getWorkspaceFolder(uri) === undefined ? undefined : uri
}

function droppedFileTooLarge(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The dropped file is too large to attach.',
    retryable: false,
  })
}

function droppedFileEmpty(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The dropped file is empty.',
    retryable: false,
  })
}
