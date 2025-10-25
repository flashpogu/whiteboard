'use client'
import React, { useEffect, useRef, useState } from 'react'
import { useShapeAI } from '../hooks/useShapeAI'
import { io, Socket } from 'socket.io-client'

type Point = { x: number; y: number; t: number }
type NPoint = { nx:number; ny:number; t:number }
type Stroke = { id: string; points: Point[]; color: string; size: number; owner?: string }
type ShapeLabel = 'circle' | 'rectangle' | 'triangle' | 'star' | 'heart' | 'cloud'
type BBox = { x:number; y:number; w:number; h:number }
type Suggestion = { label: ShapeLabel; score: number; bbox: BBox; raw: string }
type RemoteCursor = { id: string; nx:number; ny:number; color: string }

export default function AutoDraw() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [ctx, setCtx] = useState<CanvasRenderingContext2D | null>(null)

  const [isDrawing, setIsDrawing] = useState(false)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null)
  const [color, setColor] = useState('#111827')
  const [size, setSize] = useState(4)

  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  const { ready: aiReady, predict } = useShapeAI()

  // realtime
  const [socket, setSocket] = useState<Socket | null>(null)
  const [roomId, setRoomId] = useState<string>('')
  const [selfId, setSelfId] = useState<string>('')
  const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({})

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // room id
  useEffect(() => {
    if (!mounted) return
    const url = new URL(window.location.href)
    let room = url.searchParams.get('room')
    if (!room) { room = shortId(); url.searchParams.set('room', room); window.history.replaceState({}, '', url.toString()) }
    setRoomId(room)
  }, [mounted])

  // canvas sizing
  useEffect(() => {
    const el = canvasRef.current; if (!el) return
    const doResize = () => {
      const parent = containerRef.current; if (!parent) return
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      const w = parent.clientWidth
      const h = parent.clientHeight
      el.width = Math.floor(w * dpr)
      el.height = Math.floor(h * dpr)
      el.style.width = `${w}px`
      el.style.height = `${h}px`
      const _ctx = el.getContext('2d')
      if (_ctx) {
        _ctx.setTransform(1,0,0,1,0,0)
        _ctx.scale(dpr, dpr)
        _ctx.lineCap = 'round'
        _ctx.lineJoin = 'round'
        setCtx(_ctx)
        requestAnimationFrame(() => redraw(_ctx, strokes, currentStroke || undefined))
      }
    }
    doResize()
    const ro = new (window as any).ResizeObserver(doResize)
    ro.observe(containerRef.current!)
    return () => ro.disconnect()
  }, [mounted])

  useEffect(() => { if (ctx) redraw(ctx, strokes, currentStroke || undefined) }, [ctx, strokes, currentStroke])

  // suggestions (1–3 based on confidence)
  useEffect(() => {
    if (!aiReady) return
    if (!strokes.length) { setSuggestions([]); return }
    const handle = setTimeout(() => {
      const last = strokes[strokes.length - 1]
      if (!last || last.points.length < 4) { setSuggestions([]); return }
      const bbox = getBBox(last.points)
      const feats = computeFeatures(last.points, bbox)
      const preds = predict(feats, 10).filter(p=>p.score>=0.25).sort((a,b)=>b.score-a.score)
      let limit = 3
      if (preds[0]?.score >= 0.6) limit = 1
      else if (preds[0]?.score >= 0.4) limit = 2
      setSuggestions(preds.slice(0,limit).map(p=>({ label: mapToShapeLabel(p.label), score:p.score, bbox, raw:p.label } as Suggestion)))
    }, 180)
    return () => clearTimeout(handle)
  }, [strokes, aiReady])

  // socket connect
  useEffect(() => {
    if (!mounted || !roomId) return
    let active = true
    ;(async () => {
      await fetch('/api/socket')
      const s = io({ path: '/api/socket' })
      if (!active) return
      setSocket(s)
      s.on('connect', () => { setSelfId(s.id); s.emit('join_room', { room: roomId }) })

      const remoteCurrent: Record<string, Stroke | null> = {}

      s.on('state', (state: { strokes: { id:string; points:NPoint[]; color:string; size:number; owner?:string }[] }) => {
        // hydrate existing room strokes
        const hydrated: Stroke[] = state.strokes.map(st => ({
          id: st.id,
          color: st.color,
          size: st.size,
          owner: st.owner,
          points: st.points.map(p => denormalizePoint(p, canvasRef.current))
        }))
        setStrokes(hydrated)
      })

      s.on('cursor', (data: RemoteCursor) => setRemoteCursors(prev => ({ ...prev, [data.id]: data })))

      s.on('stroke_start', ({ id, stroke }) => {
        const hydrated: Stroke = {
          ...stroke,
          points: stroke.points.map((p:NPoint)=>denormalizePoint(p, canvasRef.current))
        }
        remoteCurrent[id] = hydrated
        setStrokes(prev => [...prev, hydrated])
      })

      s.on('stroke_append', ({ id, point }) => {
        const cs = remoteCurrent[id]
        if (cs) {
          const p = denormalizePoint(point, canvasRef.current)
          cs.points = [...cs.points, p]
          setStrokes(prev => prev.map(st => st.id === cs.id ? { ...cs } : st))
        } else {
          // fallback: append to last stroke
          const p = denormalizePoint(point, canvasRef.current)
          setStrokes(prev => {
            const copy = [...prev]
            const last = copy[copy.length-1]
            if (last) last.points = [...last.points, p]
            return copy
          })
        }
      })

      s.on('stroke_end', ({ id }) => { remoteCurrent[id] = null })

      s.on('clear', () => setStrokes([]))
      s.on('undo', () => setStrokes(p => p.slice(0, -1)))
    })()
    return () => { active = false; socket?.disconnect() }
  }, [mounted, roomId])

  // broadcast cursor
  useEffect(() => {
    if (!socket) return
    let raf = 0
    const move = (e: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return
      const nx = (e.clientX - rect.left) / rect.width
      const ny = (e.clientY - rect.top) / rect.height
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => socket.emit('cursor', { room: roomId, nx, ny, color }))
    }
    window.addEventListener('pointermove', move)
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf) }
  }, [socket, roomId, color])

  // pointer handlers
  const getPos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, t: performance.now() }
  }
  const handlePointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId)
    setIsDrawing(true)
    const p = getPos(e)
    const s: Stroke = { id: crypto.randomUUID(), points: [p], color, size, owner: selfId }
    setCurrentStroke(s)
    socket?.emit('stroke_start', { room: roomId, stroke: { ...s, points: [normalizePoint(p, canvasRef.current)] } })
  }
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDrawing || !currentStroke) return
    const p = getPos(e)
    setCurrentStroke({ ...currentStroke, points: [...currentStroke.points, p] })
    socket?.emit('stroke_append', { room: roomId, point: normalizePoint(p, canvasRef.current) })
  }
  const handlePointerUp = (e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId)
    if (currentStroke && currentStroke.points.length > 1) setStrokes(prev => [...prev, currentStroke])
    socket?.emit('stroke_end', { room: roomId })
    setCurrentStroke(null); setIsDrawing(false)
  }

  const undo = () => { setStrokes(s => s.slice(0,-1)); setSuggestions([]); socket?.emit('undo', { room: roomId }) }
  const clear = () => { setStrokes([]); setSuggestions([]); ctx?.clearRect(0,0,ctx.canvas.clientWidth,ctx.canvas.clientHeight); socket?.emit('clear', { room: roomId }) }
  const exportPNG = () => { const el = canvasRef.current; if (!el) return; const a=document.createElement('a'); a.href=el.toDataURL('image/png'); a.download=`autodraw-${Date.now()}.png`; a.click() }

  const applyTemplate = (sug: Suggestion) => {
    if (!ctx || !strokes.length) return
    setStrokes(s => s.slice(0, -1))
    requestAnimationFrame(() => {
      redraw(ctx, strokes.slice(0, -1))
      drawTemplate(ctx, sug.label, sug.bbox, color, size)
      setSuggestions([])
    })
  }

  if (!mounted) return null

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">WhiteBoard</h1>
          <RoomBadge roomId={roomId} />
        </div>
        <div className="flex items-center gap-3 text-sm">
          <button onClick={undo} className="px-2 py-1 rounded bg-neutral-200 hover:bg-neutral-300">Undo</button>
          <button onClick={clear} className="px-2 py-1 rounded bg-neutral-200 hover:bg-neutral-300">Clear</button>
          <button onClick={exportPNG} className="px-2 py-1 rounded bg-neutral-900 text-white">Export PNG</button>
        </div>
      </header>

      <div className="flex h-[75vh] w-full gap-3 p-3 bg-white rounded-2xl border shadow-sm">
        {/* Sidebar */}
        <div className="w-64 shrink-0 flex flex-col gap-4">
          <div className="rounded-2xl border bg-white p-3 shadow-sm">
            <div className="text-sm font-medium mb-2">Tools</div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs text-neutral-600">Color</span>
              <input aria-label="Brush color" type="color" value={color} onChange={e=>setColor(e.target.value)} />
            </div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-neutral-600">Size</span>
              <input aria-label="Brush size" type="range" min={1} max={24} value={size} onChange={e=>setSize(parseInt(e.target.value))} className="w-full"/>
              <span className="text-xs w-6 text-right">{size}</span>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-3 shadow-sm">
            <div className="text-sm font-medium mb-2">Suggestions</div>
            {suggestions.length > 0 ? (
              <div className={`grid ${suggestions.length===1?'grid-cols-1':suggestions.length===2?'grid-cols-2':'grid-cols-3'} gap-2`}>
                {suggestions.map((sug, i) => (
                  <PreviewButton key={i} sug={sug} color={color} size={size} onChoose={()=>applyTemplate(sug)} />
                ))}
              </div>
            ) : (
              <div className="text-xs text-neutral-500">Draw a shape to see suggestions…</div>
            )}
          </div>

          <div className="text-xs text-neutral-500 px-1">
            Tip: share the URL to invite collaborators.
          </div>
        </div>

        {/* Canvas */}
        <div ref={containerRef} className="relative flex-1 rounded-2xl border bg-neutral-50 overflow-hidden">
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className="touch-none cursor-crosshair w-full h-full block"
          />
          {Object.values(remoteCursors).map((c) => {
            const pos = denormalToPixels(c, canvasRef.current)
            if (!pos) return null
            return (
              <div key={c.id} className="absolute pointer-events-none" style={{ left: pos.x - 4, top: pos.y - 4 }}>
                <div className="w-3 h-3 rounded-full" style={{ background: c.color }} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function RoomBadge({ roomId }: { roomId: string }) {
  const url = typeof window !== 'undefined' ? window.location.href : ''
  const copy = async () => { if (!url) return; try { await navigator.clipboard.writeText(url); alert('Room link copied!') } catch {} }
  return (
    <button onClick={copy} className="px-2 py-1 rounded bg-neutral-200 hover:bg-neutral-300 text-xs">
      Room: {roomId} (copy link)
    </button>
  )
}

function PreviewButton({ sug, color, size, onChoose }: { sug: Suggestion; color: string; size: number; onChoose: () => void }) {
  const cRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const el = cRef.current; if (!el) return
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const W = 64, H = 64
    el.width = W * dpr; el.height = H * dpr
    el.style.width = `${W}px`; el.style.height = `${H}px`
    const ctx = el.getContext('2d'); if (!ctx) return
    ctx.setTransform(1,0,0,1,0,0); ctx.scale(dpr, dpr)
    const pad = 8
    const bbox: BBox = { x: pad, y: pad, w: W - pad*2, h: H - pad*2 }
    ctx.clearRect(0, 0, W, H)
    drawTemplate(ctx, sug.label, bbox, color, Math.max(2, size))
  }, [sug.label, color, size])
  return (
    <button onClick={onChoose} className="rounded-xl border p-2 hover:shadow transition bg-white" title={`${sug.raw} • ${(sug.score*100).toFixed(0)}%`}>
      <canvas ref={cRef} className="block" />
    </button>
  )
}

/* ----- Geometry & Features (heuristics only) ----- */
function getBBox(pts: Point[]): BBox {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity
  for (const p of pts) { if (p.x<minX) minX=p.x; if(p.y<minY) minY=p.y; if(p.x>maxX) maxX=p.x; if(p.y>maxY) maxY=p.y }
  return { x:minX, y:minY, w:Math.max(1,maxX-minX), h:Math.max(1,maxY-minY) }
}
function pathLength(pts: Point[]) { let len=0; for(let i=1;i<pts.length;i++){ const dx=pts[i].x-pts[i-1].x, dy=pts[i].y-pts[i-1].y; len += Math.hypot(dx,dy) } return len }
function circularity(pts: Point[], b: BBox){ const P=pathLength(pts); const A=b.w*b.h/Math.PI; return clamp01((4*Math.PI*A)/(P*P+1e-6)) }
function countCorners(pts: Point[]){ if(pts.length<3) return 0; let c=0; for(let i=1;i<pts.length-1;i++){ const a=angle(pts[i-1],pts[i],pts[i+1]); if(a<130) c++ } return c }
function angle(a:Point,b:Point,c:Point){ const abx=a.x-b.x,aby=a.y-b.y,cbx=c.x-b.x,cby=c.y-b.y; const dot=abx*cbx+aby*cby; const m1=Math.hypot(abx,aby), m2=Math.hypot(cbx,cby); const cos=dot/(m1*m2+1e-6); return Math.acos(Math.max(-1,Math.min(1,cos)))*180/Math.PI }
function symmetryScore(pts: Point[], b: BBox){
  const cx=b.x+b.w/2; let total=0, count=0
  for(const p of pts){ const rx=2*cx-p.x; let best=Infinity; for(const q of pts){ const d=Math.hypot(rx-q.x,p.y-q.y); if(d<best) best=d } total+=best; count++ }
  const diag=Math.hypot(b.w,b.h); return clamp01(1 - total/(count*(diag/2)+1e-6))
}
function computeFeatures(pts: Point[], b: BBox){
  return [
    countCorners(pts),
    circularity(pts, b),
    b.w / Math.max(1,b.h),
    symmetryScore(pts, b),
    pathLength(pts) / Math.max(1, Math.hypot(b.w, b.h)),
  ]
}
function clamp01(x:number){ return Math.max(0, Math.min(1, x)) }

/* ----- Mapping & Rendering ----- */
function mapToShapeLabel(label: string): ShapeLabel {
  const l = label.toLowerCase()
  if (l.includes('star')) return 'star'
  if (l.includes('cloud')) return 'cloud'
  if (l.includes('heart')) return 'heart'
  if (l.includes('triangle')) return 'triangle'
  if (l.includes('circle') || l.includes('round') || l.includes('sun')) return 'circle'
  return 'rectangle'
}

function redraw(ctx: CanvasRenderingContext2D, strokes: Stroke[], current?: Stroke) {
  const { canvas } = ctx
  ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight)
  for (const s of strokes) drawStroke(ctx, s)
  if (current) drawStroke(ctx, current)
}
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (s.points.length < 2) return
  ctx.strokeStyle = s.color
  ctx.lineWidth = s.size
  ctx.beginPath()
  ctx.moveTo(s.points[0].x, s.points[0].y)
  for (let i=1;i<s.points.length;i++){ const p=s.points[i]; ctx.lineTo(p.x,p.y) }
  ctx.stroke()
}

function drawTemplate(ctx: CanvasRenderingContext2D, label: ShapeLabel, bbox: BBox, color: string, size: number) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(2, size)
  const pad = Math.max(6, size * 1.4)
  const x = bbox.x, y = bbox.y, w = Math.max(16, bbox.w), h = Math.max(16, bbox.h)

  if (label === 'circle') {
    const r = Math.max(6, Math.min(w, h) / 2 - pad)
    ctx.beginPath(); ctx.arc(x + w/2, y + h/2, r, 0, Math.PI * 2); ctx.stroke()
  }
  if (label === 'rectangle') {
    ctx.beginPath(); ctx.rect(x + pad, y + pad, Math.max(6, w - 2*pad), Math.max(6, h - 2*pad)); ctx.stroke()
  }
  if (label === 'triangle') {
    ctx.beginPath()
    ctx.moveTo(x + w/2, y + pad)
    ctx.lineTo(x + w - pad, y + h - pad)
    ctx.lineTo(x + pad, y + h - pad)
    ctx.closePath(); ctx.stroke()
  }
  if (label === 'star') {
    drawStar(ctx, x + w/2, y + h/2, 5, Math.min(w,h)/2 - pad, Math.min(w,h)/4); ctx.stroke()
  }
  if (label === 'heart') {
    drawHeart(ctx, x + w/2, y + h/2, Math.min(w,h)/2 - pad); ctx.stroke()
  }
  if (label === 'cloud') {
    drawCloud(ctx, x + w/2, y + h/2, Math.min(w,h)/2 - pad); ctx.stroke()
  }
  ctx.restore()
}

function drawStar(ctx: CanvasRenderingContext2D, cx:number, cy:number, spikes:number, outerR:number, innerR:number) {
  let rot = Math.PI / 2 * 3, x = cx, y = cy
  ctx.beginPath(); ctx.moveTo(cx, cy - outerR)
  for (let i = 0; i < spikes; i++) {
    x = cx + Math.cos(rot) * outerR; y = cy + Math.sin(rot) * outerR; ctx.lineTo(x, y); rot += Math.PI / spikes
    x = cx + Math.cos(rot) * innerR; y = cy + Math.sin(rot) * innerR; ctx.lineTo(x, y); rot += Math.PI / spikes
  }
  ctx.lineTo(cx, cy - outerR); ctx.closePath()
}
function drawHeart(ctx: CanvasRenderingContext2D, cx:number, cy:number, r:number) {
  ctx.beginPath(); ctx.moveTo(cx, cy + r/2)
  ctx.bezierCurveTo(cx - r, cy - r/2, cx - r/2, cy - r, cx, cy - r/3)
  ctx.bezierCurveTo(cx + r/2, cy - r, cx + r, cy - r/2, cx, cy + r/2)
}
function drawCloud(ctx: CanvasRenderingContext2D, cx:number, cy:number, r:number) {
  ctx.beginPath()
  ctx.arc(cx - r/2, cy, r*0.6, Math.PI*0.5, Math.PI*1.5)
  ctx.arc(cx, cy - r/3, r*0.8, Math.PI, Math.PI*2)
  ctx.arc(cx + r/2, cy, r*0.6, Math.PI*1.5, Math.PI*0.5)
  ctx.closePath()
}

/* ----- realtime helpers ----- */
function normalizePoint(p: Point, canvas: HTMLCanvasElement | null): NPoint {
  if (!canvas) return { nx: 0, ny: 0, t: p.t }
  const rect = canvas.getBoundingClientRect()
  return { nx: p.x / rect.width, ny: p.y / rect.height, t: p.t }
}
function denormalizePoint(p: NPoint, canvas: HTMLCanvasElement | null): Point {
  const rect = canvas?.getBoundingClientRect(); if (!rect) return { x:0,y:0,t:p.t }
  return { x: p.nx * rect.width, y: p.ny * rect.height, t: p.t }
}
function denormalToPixels(c: { nx:number; ny:number }, canvas: HTMLCanvasElement | null) {
  const rect = canvas?.getBoundingClientRect(); if (!rect) return null
  return { x: c.nx * rect.width, y: c.ny * rect.height }
}
function shortId(){ return Math.random().toString(36).slice(2,8) }
