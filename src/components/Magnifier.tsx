import { useEffect, useRef, useState } from 'react';
import { Expand, ZoomIn } from 'lucide-react';

const ZOOMS = [2, 2.5, 3, 4];
const LENS_H = 130; // magnifier height in px (about 3 rows of the sheet at 2.5×)
const GAP = 28; // distance between the cursor and the magnifier

/**
 * An image with a wide, row-shaped magnifier that follows the mouse (or finger).
 * The magnifier floats over the page (it may extend beyond the photo) so one sheet row
 * — CID, member name and the payment columns — fits in it at once.
 * A frame on the photo shows which area is magnified. Mouse wheel changes the zoom.
 */
export default function Magnifier({ src, alt }: { src: string; alt: string }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(2.5);
  const [lens, setLens] = useState<{
    x: number; y: number; w: number; h: number; clientX: number; clientY: number;
  } | null>(null);
  const lensOn = useRef(false);
  lensOn.current = !!lens;

  // Wheel = zoom while the magnifier is showing (native listener so the panel doesn't scroll too)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!lensOn.current) return;
      e.preventDefault();
      setZoom((z) => Math.min(6, Math.max(1.5, z + (e.deltaY < 0 ? 0.25 : -0.25))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function track(clientX: number, clientY: number) {
    const img = imgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return setLens(null);
    setLens({ x, y, w: r.width, h: r.height, clientX, clientY });
  }

  function openFull() {
    // data: URLs can't be opened in a new tab directly, so go through a blob URL
    fetch(src)
      .then((r) => r.blob())
      .then((b) => {
        const url = URL.createObjectURL(b);
        window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      });
  }

  // Magnifier geometry (viewport coordinates)
  let view: { left: number; top: number; width: number } | null = null;
  if (lens) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Wide enough to show ~70% of the page width: CID + name + amount columns of a row
    const width = Math.min(vw - 16, Math.max(560, lens.w * zoom * 0.72));
    const left = Math.min(vw - width - 8, Math.max(8, lens.clientX - width / 2));
    const below = lens.clientY + GAP;
    const top = below + LENS_H < vh - 8 ? below : Math.max(8, lens.clientY - GAP - LENS_H);
    view = { left, top, width };
  }
  // The area of the photo that the magnifier shows
  const frameW = view && lens ? view.width / zoom : 0;
  const frameH = LENS_H / zoom;
  // Keep the magnified area centred on the cursor, except clamp so it doesn't run off the photo
  const cx = lens ? Math.min(Math.max(lens.x, frameW / 2), Math.max(frameW / 2, lens.w - frameW / 2)) : 0;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <ZoomIn className="h-3.5 w-3.5" /> Point at a row to magnify it
        </span>
        <span className="flex items-center gap-1">
          {ZOOMS.map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoom(z)}
              className={`rounded px-1.5 py-0.5 font-medium ${zoom === z ? 'bg-emerald-500 text-white' : 'hover:bg-slate-100'}`}
            >
              {z}×
            </button>
          ))}
          <button type="button" onClick={openFull} title="Open full size in a new tab" className="ml-1 rounded p-1 hover:bg-slate-100">
            <Expand className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      <div
        ref={boxRef}
        className="relative cursor-crosshair touch-none select-none overflow-hidden rounded-lg border border-slate-200"
        onMouseMove={(e) => track(e.clientX, e.clientY)}
        onMouseLeave={() => setLens(null)}
        onTouchStart={(e) => track(e.touches[0].clientX, e.touches[0].clientY)}
        onTouchMove={(e) => track(e.touches[0].clientX, e.touches[0].clientY)}
        onTouchEnd={() => setLens(null)}
      >
        <img ref={imgRef} src={src} alt={alt} draggable={false} className="block w-full" />
        {lens && (
          // frame showing the magnified area
          <div
            className="pointer-events-none absolute rounded-sm border-2 border-emerald-500 bg-emerald-400/10"
            style={{ width: frameW, height: frameH, left: cx - frameW / 2, top: lens.y - frameH / 2 }}
          />
        )}
      </div>

      {lens && view && (
        <div
          className="pointer-events-none fixed z-[60] overflow-hidden rounded-xl border-2 border-white bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.35),0_12px_32px_rgba(15,23,42,0.45)]"
          style={{
            left: view.left,
            top: view.top,
            width: view.width,
            height: LENS_H,
            backgroundImage: `url("${src}")`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: `${lens.w * zoom}px ${lens.h * zoom}px`,
            backgroundPosition: `${-(cx * zoom - view.width / 2)}px ${-(lens.y * zoom - LENS_H / 2)}px`,
          }}
        >
          {/* guide line through the row being read */}
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-emerald-500/50" />
          <span className="absolute bottom-1.5 left-2 rounded bg-slate-900/60 px-1.5 py-0.5 text-[11px] text-white">
            {zoom}× · scroll to zoom
          </span>
        </div>
      )}
    </div>
  );
}
