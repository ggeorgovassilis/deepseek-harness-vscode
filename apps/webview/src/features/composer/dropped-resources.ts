import { MAX_PROMPT_ATTACHMENTS } from '@dsh-vscode/webview-protocol'

/**
 * VS Code workbench drags never hand a Webview file bytes. The Explorer, open
 * tabs and other workbench lists set `ResourceURLs`: a JSON array of resource
 * URIs produced by the workbench when the drag starts. `CodeFiles` carries local
 * `fsPath` strings for the same drag, but a path would have to be turned back
 * into a URI here, so it is only used to recognize that a resource drag is in
 * progress.
 *
 * The drag data store stores every type string ASCII-lowercased, so these arrive
 * as `resourceurls` and `codefiles`; only the `Files` pseudo-type that Chromium
 * appends for a file drag keeps its capital letter. `getData` lowercases its
 * argument too, so the reads below use the lowercased names.
 *
 * An Explorer drag only reaches a Webview while Shift is held: without it the
 * workbench keeps the drop for its own editor drop target and the iframe never
 * sees an event (microsoft/vscode#182449, resolved by letting the workbench
 * re-enable the Webview while Shift is down).
 */
const WORKBENCH_DRAG_TYPES: readonly string[] = ['resourceurls', 'codefiles']
const RESOURCE_URI_LIST = 'text/uri-list'
/** Mirrors the protocol's per-URI bound so one long path cannot fail the batch. */
const MAX_RESOURCE_URI_CHARS = 2048
/** Same bound the protocol and the attachment store enforce for one message. */
const MAX_DROPPED_RESOURCES = MAX_PROMPT_ATTACHMENTS

export interface DroppedResourceDrag {
  /** Resources the workbench put on the drag payload, in drop order. */
  readonly uris: readonly string[]
  /** Entries left out for exceeding the per-message or per-URI bound. */
  readonly ignored: number
}

/** Whether the hovered drag carries workbench resources rather than `File` objects. */
export function isResourceDrag(types: readonly string[]): boolean {
  return types.some((type) => WORKBENCH_DRAG_TYPES.includes(type.toLowerCase()))
}

/**
 * Read the resource URIs a workbench drag delivers. `getData` is only readable
 * during the drop event, so this runs once, synchronously, before the transfer
 * is released. Relative or scheme-less values are not resources the Host could
 * attribute to a provider and are dropped here; the Host still decides whether
 * an absolute URI names a file inside an open workspace folder.
 *
 * Only a workbench drag is read: a plain `text/uri-list` drag from another app
 * is not claimed, so its default text insertion still happens and its links
 * never reach the Host.
 */
export function droppedResourceUris(dataTransfer: { getData(format: string): string }): DroppedResourceDrag {
  const uris: string[] = []
  const seen = new Set<string>()
  let ignored = 0
  const add = (candidate: string | undefined): void => {
    const value = candidate?.trim() ?? ''
    // A single-letter "scheme" is a Windows drive, not a resource URI.
    if (!/^[A-Za-z][A-Za-z0-9+.-]+:/u.test(value)) return
    if (value.length > MAX_RESOURCE_URI_CHARS) {
      ignored += 1
      return
    }
    if (seen.has(value)) return
    if (uris.length >= MAX_DROPPED_RESOURCES) {
      ignored += 1
      return
    }
    seen.add(value)
    uris.push(value)
  }
  for (const value of parseJsonStringArray(readTransferValue(dataTransfer, 'resourceurls'))) add(value)
  for (const value of parseUriList(readTransferValue(dataTransfer, RESOURCE_URI_LIST))) add(value)
  return { uris, ignored }
}

function readTransferValue(dataTransfer: { getData(format: string): string }, format: string): string {
  try {
    return dataTransfer.getData(format) ?? ''
  } catch {
    // A transfer can be gone by the time a nested handler reads it.
    return ''
  }
}

function parseJsonStringArray(value: string): readonly string[] {
  if (value.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * RFC 2483 `text/uri-list`: one URI per line, `#` starts a comment line. Other
 * workbench surfaces and external apps use it for the same purpose, but it is
 * merged into a workbench drag rather than used to claim one by itself.
 */
function parseUriList(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}
