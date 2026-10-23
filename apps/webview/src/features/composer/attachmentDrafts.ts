import type { PromptAttachment } from '@dsh-vscode/domain'

/**
 * Extra identity available for an attachment before the Extension Host has
 * returned its opaque handle. It stays in the Webview only for draft-level
 * de-duplication and is never sent as authority to DSH.
 */
export type AttachmentDraftOrigin =
  | {
      readonly kind: 'browser-file'
      readonly sizeBytes: number
      readonly lastModified: number
      readonly relativePath: string
    }
  | {
      readonly kind: 'open-file'
      readonly id: string
    }
  | {
      readonly kind: 'dropped-resource'
      /**
       * The URI the workbench put on the drag payload. It already reached the
       * Webview as drop data and stays here only as a draft identity; the
       * Extension Host never returns it.
       */
      readonly id: string
    }

/** Build a stable, presentation-safe identity for one draft attachment. */
export function attachmentDraftKey(
  attachment: Pick<PromptAttachment, 'name' | 'mimeType'>,
  origin?: AttachmentDraftOrigin,
): string {
  const originKey =
    origin === undefined
      ? 'opaque'
      : origin.kind === 'open-file'
        ? `open:${stableText(origin.id)}`
        : origin.kind === 'dropped-resource'
          ? // Resources are case-sensitive: two workspace files may differ only
            // by case, so this identity is not normalized like pasted names.
            `drop:${origin.id}`
          : `file:${origin.sizeBytes}:${origin.lastModified}:${stableText(origin.relativePath)}`
  return [originKey, stableText(attachment.name), stableText(attachment.mimeType)].join('\u0000')
}

export function browserFileOrigin(file: File): AttachmentDraftOrigin {
  return {
    kind: 'browser-file',
    sizeBytes: file.size,
    lastModified: file.lastModified,
    relativePath: file.webkitRelativePath,
  }
}

function stableText(value: string | undefined): string {
  return (value ?? '').trim().normalize('NFC').toLowerCase()
}
