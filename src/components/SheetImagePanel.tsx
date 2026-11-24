import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ImageOff, Maximize2, RotateCw, Trash2, Upload, X } from 'lucide-react'
import { formatLongDate } from '../lib/format'
import { sheetImagesTable, type SheetImageRecord } from '../lib/data'
import { Button, ConfirmDialog, cx } from './ui'

/** Shows the paper-sheet photo(s) uploaded for one group and date, next to the Day sheet. */
export function SheetImagePanel({ groupId, date, onUpload }: { groupId: number; date: string; onUpload: () => void }) {
  const images = useLiveQuery(async () => {
    const t = sheetImagesTable()
    if (!t) return []
    const rows = await t.where('[groupId+date]').equals([groupId, date]).toArray()
    return rows.sort((a, b) => a.uploadedAt - b.uploadedAt)
  }, [groupId, date])

  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => setIndex(0), [groupId, date])
  const list = images ?? []
  const current = list[Math.min(index, list.length - 1)]
  const url = useObjectUrl(current?.blob)

  const rotate = async () => {
    const t = sheetImagesTable()
    if (t && current?.id != null) await t.update(current.id, { rotation: ((current.rotation ?? 0) + 90) % 360 })
  }
  const remove = async () => {
    const t = sheetImagesTable()
    if (t && current?.id != null) await t.delete(current.id)
    setIndex(0)
  }

  return (
    <aside className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden print:hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-700 flex-1">Uploaded sheet</h2>
        {current && (
          <>
            <IconBtn title="Rotate" onClick={rotate}>
              <RotateCw size={16} />
            </IconBtn>
            <IconBtn title="View full size" onClick={() => setZoom(true)}>
              <Maximize2 size={16} />
            </IconBtn>
            <IconBtn title="Remove photo" onClick={() => setConfirmRemove(true)} danger>
              <Trash2 size={16} />
            </IconBtn>
          </>
        )}
      </div>

      {!current ? (
        <div className="px-6 py-12 text-center">
          <ImageOff className="mx-auto text-slate-300 mb-2" size={32} />
          <p className="text-sm text-slate-500 mb-4">No sheet photo for {formatLongDate(date)}.</p>
          <Button onClick={onUpload}>
            <Upload size={16} /> Upload sheet
          </Button>
        </div>
      ) : (
        <>
          <button className="block w-full bg-slate-100 cursor-zoom-in" onClick={() => setZoom(true)} title="Click to view full size">
            <div className="max-h-[calc(100vh-14rem)] overflow-auto grid place-items-center p-2">
              {url && <RotatedImage src={url} rotation={current.rotation ?? 0} alt={current.name} className="max-w-full" />}
            </div>
          </button>
          {list.length > 1 && (
            <div className="flex gap-2 p-2 border-t border-slate-100 overflow-x-auto">
              {list.map((img, i) => (
                <Thumb key={img.id} img={img} active={img === current} onClick={() => setIndex(i)} />
              ))}
            </div>
          )}
          <div className="px-4 py-2 border-t border-slate-100 text-xs text-slate-500 truncate" title={current.name}>
            {current.name} · uploaded {new Date(current.uploadedAt).toLocaleString()}
          </div>
        </>
      )}

      {zoom && url && current && (
        <div className="fixed inset-0 z-50 bg-slate-900/90 flex flex-col" onClick={() => setZoom(false)}>
          <div className="flex items-center justify-between px-4 py-3 text-white">
            <span className="text-sm truncate">{current.name}</span>
            <button className="p-1.5 rounded hover:bg-white/10" aria-label="Close" onClick={() => setZoom(false)}>
              <X size={20} />
            </button>
          </div>
          <div className="flex-1 overflow-auto grid place-items-center p-4" onClick={(e) => e.stopPropagation()}>
            <RotatedImage src={url} rotation={current.rotation ?? 0} alt={current.name} className="max-w-none" />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="Remove this photo?"
        message="Only the photo is removed. Amounts already imported stay on the sheet."
        confirmLabel="Remove photo"
        onConfirm={remove}
        onClose={() => setConfirmRemove(false)}
      />
    </aside>
  )
}

function IconBtn({ children, title, onClick, danger }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cx('p-1.5 rounded-md', danger ? 'text-red-500 hover:bg-red-50' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100')}
    >
      {children}
    </button>
  )
}

function Thumb({ img, active, onClick }: { img: SheetImageRecord; active: boolean; onClick: () => void }) {
  const url = useObjectUrl(img.blob)
  return (
    <button onClick={onClick} className={cx('h-16 w-12 shrink-0 rounded border-2 overflow-hidden bg-slate-100', active ? 'border-emerald-500' : 'border-transparent')}>
      {url && <img src={url} alt={img.name} className="h-full w-full object-cover" style={{ transform: `rotate(${img.rotation ?? 0}deg)` }} />}
    </button>
  )
}

/** Rotates by 90° steps while keeping the rotated box in normal layout flow. */
function RotatedImage({ src, rotation, alt, className }: { src: string; rotation: number; alt: string; className?: string }) {
  const sideways = rotation % 180 !== 0
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  if (!sideways) return <img src={src} alt={alt} className={className} />
  // For 90/270 swap the box dimensions so the rotated image doesn't overlap the panel.
  return (
    <div className="relative" style={size ? { width: size.h, height: size.w } : undefined}>
      <img
        src={src}
        alt={alt}
        onLoad={(e) => {
          const el = e.currentTarget
          const maxW = el.parentElement?.parentElement?.clientWidth ?? el.naturalHeight
          const scale = Math.min(1, maxW / el.naturalHeight)
          setSize({ w: el.naturalWidth * scale, h: el.naturalHeight * scale })
        }}
        className="absolute left-1/2 top-1/2 max-w-none"
        style={{
          width: size?.w,
          height: size?.h,
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        }}
      />
    </div>
  )
}

function useObjectUrl(blob: Blob | undefined) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob])
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
  }, [url])
  return url
}
