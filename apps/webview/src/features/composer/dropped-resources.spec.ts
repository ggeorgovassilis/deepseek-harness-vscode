import { describe, expect, it } from 'vitest'
import { droppedResourceUris, isResourceDrag } from './dropped-resources.js'

function transfer(values: Readonly<Record<string, string>>): { getData(format: string): string } {
  return { getData: (format) => values[format] ?? '' }
}

describe('workbench resource drags', () => {
  it('reads the workbench resource list in drop order', () => {
    expect(
      droppedResourceUris(transfer({ resourceurls: JSON.stringify(['file:///w/a.ts', 'file:///w/b.png']) })),
    ).toEqual({ uris: ['file:///w/a.ts', 'file:///w/b.png'], ignored: 0 })
  })

  it('recognizes the lowercased workbench types a real drop store exposes', () => {
    expect(isResourceDrag(['resourceurls', 'text/plain'])).toBe(true)
    expect(isResourceDrag(['codefiles'])).toBe(true)
    // Type strings are ASCII-lowercased by the drag data store; normalizing
    // keeps the check independent of how a fixture spells the type.
    expect(isResourceDrag(['ResourceURLs'])).toBe(true)
    expect(isResourceDrag(['CodeFiles'])).toBe(true)
    // Plain text, file drags and a bare URI list from another app are not
    // workbench resources and must keep their native drop behavior.
    expect(isResourceDrag(['text/plain'])).toBe(false)
    expect(isResourceDrag(['Files'])).toBe(false)
    expect(isResourceDrag(['text/uri-list'])).toBe(false)
  })

  it('merges a URI list, skipping comments, blanks and relative values', () => {
    expect(
      droppedResourceUris(
        transfer({
          resourceurls: 'not json',
          'text/uri-list':
            '# a comment\r\nfile:///w/a.ts\r\n\r\nnotes.txt\r\nfile:///w/a.ts\r\nfile:///w/b.ts',
        }),
      ),
    ).toEqual({ uris: ['file:///w/a.ts', 'file:///w/b.ts'], ignored: 0 })
  })

  it('ignores non-string entries and reports entries over the drop bounds', () => {
    const many = Array.from({ length: 25 }, (_, index) => `file:///w/${index}.ts`)
    const overLong = `file:///w/${'x'.repeat(2048)}.ts`
    const dropped = droppedResourceUris(
      transfer({ resourceurls: JSON.stringify([7, null, overLong, ...many]) }),
    )
    expect(dropped.uris).toHaveLength(20)
    expect(dropped.ignored).toBe(6)
  })

  it('treats a transfer that is already gone as an empty drop', () => {
    expect(
      droppedResourceUris({
        getData: () => {
          throw new Error('the data store is no longer readable')
        },
      }),
    ).toEqual({ uris: [], ignored: 0 })
  })
})
