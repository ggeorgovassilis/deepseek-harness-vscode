import { useEffect, useRef, useState, type DragEvent } from 'react'
import { droppedResourceUris, isResourceDrag } from './dropped-resources.js'

export type ComposerDropKind = 'files' | 'resources'

function dropKind(dataTransfer: DataTransfer | null | undefined): ComposerDropKind | undefined {
  if (dataTransfer === null || dataTransfer === undefined) return undefined
  const types = Array.from(dataTransfer.types)
  // `Files` is the one drag type Chromium reports with a capital letter; the
  // workbench payload types arrive lowercased (see `isResourceDrag`).
  // An OS drag that also carries a workbench resource list is still bytes the
  // Webview already holds; prefer it over a round trip to the Host.
  if (types.includes('Files')) return 'files'
  return isResourceDrag(types) ? 'resources' : undefined
}

/**
 * Attachment drag & drop: the window-level readiness listeners (a drag may
 * start anywhere) and the form-level enter/over/leave/drop handlers. The
 * overlay state is `blocked` when the composer or its attachments are
 * disabled, `ready` while a file or workspace resource hovers, and cleared once
 * the drag ends.
 *
 * Two payload kinds arrive here. Dropping a file from the OS gives `File`
 * objects; dropping a resource from the VS Code Explorer, an editor tab or
 * another workbench list gives URIs that only the Extension Host can read.
 */
export function useComposerDragDrop(props: {
  readonly disabled: boolean
  readonly attachmentsDisabled: boolean
  readonly ingestFiles: (files: readonly File[] | FileList) => void
  readonly attachResources: (uris: readonly string[], ignored: number) => void
}): {
  readonly dragging: boolean
  readonly dropState: 'ready' | 'blocked' | undefined
  readonly dropKind: ComposerDropKind | undefined
  readonly onDragEnter: (event: DragEvent<HTMLFormElement>) => void
  readonly onDragOver: (event: DragEvent<HTMLFormElement>) => void
  readonly onDragLeave: () => void
  readonly onDrop: (event: DragEvent<HTMLFormElement>) => void
} {
  const { disabled, attachmentsDisabled, ingestFiles, attachResources } = props
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [dropState, setDropState] = useState<'ready' | 'blocked' | undefined>(undefined)
  const [dropKindState, setDropKindState] = useState<ComposerDropKind | undefined>(undefined)
  useEffect(() => {
    const onDragOver = (event: globalThis.DragEvent): void => {
      if (dropKind(event.dataTransfer) === undefined) return
      event.preventDefault()
      setDropState(disabled || attachmentsDisabled ? 'blocked' : 'ready')
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (event.relatedTarget === null) setDropState(undefined)
    }
    const onDrop = (event: globalThis.DragEvent): void => {
      if (dropKind(event.dataTransfer) === undefined) return
      event.preventDefault()
      setDropState(undefined)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [attachmentsDisabled, disabled])
  const onDragEnter = (event: DragEvent<HTMLFormElement>): void => {
    const kind = dropKind(event.dataTransfer)
    if (kind === undefined) return
    event.preventDefault()
    if (disabled || attachmentsDisabled) {
      setDropState('blocked')
      return
    }
    dragDepth.current += 1
    setDragging(true)
    setDropKindState(kind)
    setDropState('ready')
  }
  const onDragOver = (event: DragEvent<HTMLFormElement>): void => {
    if (dropKind(event.dataTransfer) === undefined) return
    event.preventDefault()
    if (disabled || attachmentsDisabled) setDropState('blocked')
  }
  const onDragLeave = (): void => {
    if (dragDepth.current === 0) return
    dragDepth.current -= 1
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event: DragEvent<HTMLFormElement>): void => {
    const kind = dropKind(event.dataTransfer)
    if (kind === undefined) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (disabled || attachmentsDisabled) {
      setDropState(undefined)
      return
    }
    setDropState(undefined)
    if (kind === 'files') {
      ingestFiles(event.dataTransfer.files)
      return
    }
    // A resource drag can legitimately carry nothing attachable (a folder, or
    // a transfer the workbench already released); the composer reports that
    // instead of failing silently.
    const dropped = droppedResourceUris(event.dataTransfer)
    attachResources(dropped.uris, dropped.ignored)
  }
  return { dragging, dropState, dropKind: dropKindState, onDragEnter, onDragOver, onDragLeave, onDrop }
}
