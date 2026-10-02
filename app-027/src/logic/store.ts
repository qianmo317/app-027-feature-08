import { reactive, watch } from 'vue'
import {
  DEFAULT_CUT_SETTINGS,
  DEFAULT_EXPORT_CFG,
  DEFAULT_SHEET,
  type BatchCfg,
  type ContourWarning,
  type CutSettings,
  type ExportCfg,
  type MaterialPreset,
  type Project,
  type Shape,
  type Sheet,
} from './types'
import { computeShape, shapeSignature, type ComputedShape } from './pipeline'
import { buildBatchShape, buildJob, type Job } from './job'
import { contourFingerprint, interiorPoint, pointInPolygon, uid } from './geometry'
import { importSvgText, type ImportResult } from './importer'
import type { NestingOverrides } from './types'
import { defaultMaterials } from '@/data/materials'

const LS_KEY = 'papercut-plotter-studio/v1'

type Persisted = {
  version: number
  projects: Project[]
  materials: MaterialPreset[]
}

type StoreState = {
  projects: Project[]
  materials: MaterialPreset[]
  ready: boolean
  lastError: string | null
}

export const state = reactive<StoreState>({
  projects: [],
  materials: [],
  ready: false,
  lastError: null,
})

/** 派生计算结果缓存（按几何签名失效，不持久化） */
const computedCache = reactive<Record<string, ComputedShape>>({})
const batchCache = new Map<string, ComputedShape>()

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function loadState(): void {
  state.materials = defaultMaterials()
  if (!canUseStorage()) {
    state.ready = true
    return
  }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Persisted
      if (parsed && Array.isArray(parsed.projects)) {
        state.projects = parsed.projects.map(normalizeProject)
      }
      if (parsed && Array.isArray(parsed.materials) && parsed.materials.length > 0) {
        state.materials = parsed.materials.map((m) => ({ ...m, backing: m.backing ?? '常规垫板' }))
      }
    }
  } catch (e) {
    state.lastError = `本地数据读取失败：${(e as Error).message}`
  }
  state.ready = true
  recomputeAll()
}

export function saveNow(): void {
  if (!canUseStorage()) return
  try {
    const data: Persisted = { version: 1, projects: state.projects, materials: state.materials }
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch (e) {
    state.lastError = `本地保存失败：${(e as Error).message}`
  }
}

let saveTimer: number | null = null
export function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 250)
}

function sanitizeNesting(n: Shape['nesting']): NestingOverrides | undefined {
  if (!n || typeof n !== 'object' || !n.byFp) return undefined
  const byFp: NestingOverrides['byFp'] = {}
  for (const [fp, m] of Object.entries(n.byFp)) {
    if (!m || typeof m.at !== 'number') continue
    byFp[fp] = { parentFp: m.parentFp ?? null, at: m.at }
  }
  return Object.keys(byFp).length > 0 ? { byFp } : undefined
}

function normalizeProject(p: Project): Project {
  return {
    ...p,
    settings: { ...DEFAULT_CUT_SETTINGS, ...(p.settings ?? {}) },
    export: { ...DEFAULT_EXPORT_CFG, ...(p.export ?? {}) },
    sheet: p.sheet ?? { ...DEFAULT_SHEET },
    shapes: (p.shapes ?? []).map((s) => ({
      ...s,
      contours: (s.contours ?? []).map((c) => ({ ...c, holes: c.holes ?? [], bridges: c.bridges ?? [], warnings: c.warnings ?? [] })),
      nesting: sanitizeNesting(s.nesting),
    })),
    layerNames: p.layerNames ?? ['图层 1'],
  }
}

export function materialOf(p: Project): MaterialPreset | null {
  return state.materials.find((m) => m.id === p.materialId) ?? state.materials[0] ?? null
}

/** 重算派生数据（清理结果 → 连刀点 → 刀补 → 包含树 → 切割顺序） */
export function recomputeProject(p: Project, force = false): void {
  const material = materialOf(p)
  for (const shape of p.shapes) {
    const sig = shapeSignature(shape, p.settings, material)
    const cached = computedCache[shape.id]
    if (!force && cached && cached.signature === sig) continue
    const res = computeShape(shape, p.settings, material)
    applyComputed(shape, res)
    computedCache[shape.id] = res
  }
}

export function recomputeAll(force = false): void {
  for (const p of state.projects) recomputeProject(p, force)
}

/** 回写清理/派生警告（连刀点中只有手工放置的保存在数据模型里） */
function applyComputed(shape: Shape, res: ComputedShape): void {
  for (const c of shape.contours) {
    const base = c.warnings.filter(
      (w) => w === 'not_closed' || w === 'self_intersect' || w === 'duplicate' || w === 'too_short',
    ) as ContourWarning[]
    const extra = res.warningUpdates.get(c.id) ?? []
    c.warnings = [...base, ...extra.filter((w) => !base.includes(w))]
  }
}

export function computedOf(shapeId: string): ComputedShape | null {
  return computedCache[shapeId] ?? null
}

/** 排版任务：批量排版开启时只排所选纹样，否则排全部形状 */
export function jobOf(p: Project): { job: Job; shape: Shape | null; isBatch: boolean; computed: Map<string, ComputedShape> } {
  const material = materialOf(p)
  const start = { x: 0, y: 0 }
  const batch = p.batch
  if (batch && batch.enabled) {
    const src = p.shapes.find((s) => s.id === p.batchShapeId) ?? p.shapes[0]
    if (src) {
      const tiled = buildBatchShape(src, batch)
      const sig = `batch|${shapeSignature(src, p.settings, material)}|${batch.rows}|${batch.cols}|${batch.gapXMm}|${batch.gapYMm}|${batch.mode}`
      let comp = batchCache.get(sig)
      if (!comp) {
        comp = computeShape(tiled, p.settings, material, start)
        batchCache.set(sig, comp)
        if (batchCache.size > 24) {
          const firstKey = batchCache.keys().next().value
          if (firstKey !== undefined) batchCache.delete(firstKey)
        }
      }
      const map = new Map<string, ComputedShape>([[tiled.id, comp]])
      const job = buildJob([tiled], map, layerOrderOf(p), { sharedEdge: batch.sharedEdge, start })
      return { job, shape: tiled, isBatch: true, computed: map }
    }
  }
  recomputeProject(p)
  const map = new Map<string, ComputedShape>()
  for (const s of p.shapes) {
    const c = computedCache[s.id]
    if (c) map.set(s.id, c)
  }
  const job = buildJob(p.shapes, map, layerOrderOf(p), { sharedEdge: false, start })
  return { job, shape: null, isBatch: false, computed: map }
}

export function layerOrderOf(p: Project): number[] {
  const set = new Set(p.shapes.map((s) => s.layer))
  return Array.from(set).sort((a, b) => a - b)
}

// ---------------- 项目与形状操作 ----------------

function newProject(name: string, shapes: Shape[]): Project {
  const now = Date.now()
  return {
    id: uid('p'),
    name,
    createdAt: now,
    updatedAt: now,
    shapes,
    settings: { ...DEFAULT_CUT_SETTINGS },
    export: { ...DEFAULT_EXPORT_CFG },
    sheet: { ...DEFAULT_SHEET },
    materialId: state.materials[0]?.id ?? '',
    layerNames: ['图层 1'],
    batch: { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' },
  }
}

export function createProjectFromShapes(name: string, shapes: Shape[]): Project {
  const p = newProject(name, shapes)
  state.projects.unshift(p)
  recomputeProject(p, true)
  scheduleSave()
  return p
}

export function createBlankProject(name: string): Project {
  return createProjectFromShapes(name, [{ id: uid('s'), name: '新建形状', contours: [], layer: 0 }])
}

export function getProject(id: string): Project | undefined {
  return state.projects.find((p) => p.id === id)
}

export function deleteProject(id: string): void {
  const i = state.projects.findIndex((p) => p.id === id)
  if (i >= 0) {
    state.projects.splice(i, 1)
    scheduleSave()
  }
}

export function duplicateProject(id: string): Project | null {
  const src = getProject(id)
  if (!src) return null
  const copy: Project = JSON.parse(JSON.stringify(src))
  copy.id = uid('p')
  copy.name = `${src.name} 副本`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  // 重新分配 id，避免缓存串用；层级人工判定按几何指纹在副本内重建
  for (const s of copy.shapes) {
    s.id = uid('s')
    const idByFp = new Map<string, string>()
    for (const c of s.contours) {
      c.id = uid('c')
      c.holes = []
      c.bridges = []
      idByFp.set(contourFingerprint(c.points, c.closed), c.id)
    }
    if (s.nesting) s.nesting = sanitizeNesting(s.nesting)
  }
  state.projects.unshift(copy)
  recomputeProject(copy, true)
  scheduleSave()
  return copy
}

export function touch(p: Project): void {
  p.updatedAt = Date.now()
  scheduleSave()
}

export function addShape(p: Project, shape: Shape): void {
  p.shapes.push(shape)
  recomputeProject(p, true)
  touch(p)
}

export function removeShape(p: Project, shapeId: string): void {
  const i = p.shapes.findIndex((s) => s.id === shapeId)
  if (i >= 0) {
    p.shapes.splice(i, 1)
    delete computedCache[shapeId]
    touch(p)
  }
}

export function updateSettings(p: Project, patch: Partial<CutSettings>): void {
  Object.assign(p.settings, patch)
  recomputeProject(p, true)
  touch(p)
}

export function updateExport(p: Project, patch: Partial<ExportCfg>): void {
  Object.assign(p.export, patch)
  touch(p)
}

export function updateSheet(p: Project, sheet: Sheet): void {
  p.sheet = { ...sheet }
  touch(p)
}

export function updateBatch(p: Project, patch: Partial<BatchCfg>): void {
  if (!p.batch) p.batch = { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' }
  Object.assign(p.batch, patch)
  touch(p)
}

export function setMaterial(p: Project, materialId: string): void {
  p.materialId = materialId
  recomputeProject(p, true)
  touch(p)
}

/** 一键闭合所有未闭合轮廓 */
export function closeAllOpen(p: Project): number {
  let n = 0
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (!c.closed && c.points.length >= 3) {
        c.closed = true
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        n += 1
      }
    }
  }
  if (n > 0) {
    recomputeProject(p, true)
    touch(p)
  }
  return n
}

export function closeContour(p: Project, contourId: string): boolean {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id === contourId && !c.closed && c.points.length >= 3) {
        c.closed = true
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        recomputeProject(p, true)
        touch(p)
        return true
      }
    }
  }
  return false
}

export function removeContour(p: Project, contourId: string): void {
  for (const shape of p.shapes) {
    const i = shape.contours.findIndex((c) => c.id === contourId)
    if (i >= 0) {
      shape.contours.splice(i, 1)
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

/** 手工放置连刀点：在指定轮廓上离 p 最近的顶点处 */
export function placeManualBridge(p: Project, contourId: string, atIndex: number): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id !== contourId) continue
      if (!c.bridges.some((b) => b.atIndex === atIndex)) {
        c.bridges.push({ atIndex, widthMm: p.settings.bridgeWidthMm })
      }
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

export function clearManualBridges(p: Project, contourId?: string): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (contourId && c.id !== contourId) continue
      c.bridges = []
    }
  }
  recomputeProject(p, true)
  touch(p)
}

// ---------------- 层级人工判定 ----------------

function findContour(p: Project, contourId: string): { shape: Shape; contour: Shape['contours'][number] } | null {
  for (const shape of p.shapes) {
    const contour = shape.contours.find((c) => c.id === contourId)
    if (contour) return { shape, contour }
  }
  return null
}

function ensureNesting(shape: Shape): NestingOverrides {
  if (!shape.nesting) shape.nesting = { byFp: {} }
  return shape.nesting
}

/** 不允许的指定：把祖先挂到自己子孙下（成环） */
export function canSetParent(p: Project, contourId: string, parentId: string | null): boolean {
  if (parentId === null) return true
  if (parentId === contourId) return false
  // 沿当前生效的父链从 parentId 向上走，遇到 contourId 即成环
  let cur: string | null = parentId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    if (cur === contourId) return false
    const curId: string = cur
    let next: string | null = null
    for (const s of p.shapes) {
      const tree = computedOf(s.id)?.tree
      const pid: string | null | undefined = tree?.nodeById.get(curId)?.parentId
      if (tree && pid !== undefined) {
        next = pid
        break
      }
    }
    cur = next
  }
  return true
}

/** 子轮廓代表点是否落在父轮廓内（重导入继承时区分同指纹的多个副本） */
function pointInsideLazy(child: Shape['contours'][number], parent: Shape['contours'][number]): boolean {
  if (!child.closed || !parent.closed) return false
  return pointInPolygon(interiorPoint(child.points), parent.points)
}

/**
 * 手工指定层级：把 contourId 设为 parentId 的直接下一层；parentId=null 改为顶层。
 * 判定按几何指纹记录（重新导入同一份图仍生效）。
 */
export function setContourParent(p: Project, contourId: string, parentId: string | null): boolean {
  const hit = findContour(p, contourId)
  if (!hit) return false
  if (parentId !== null && !findContour(p, parentId)) return false
  if (!canSetParent(p, contourId, parentId)) return false
  const { shape, contour } = hit
  const nesting = ensureNesting(shape)
  const childFp = contourFingerprint(contour.points, contour.closed)
  if (parentId === null) {
    nesting.byFp[childFp] = { parentFp: null, at: Date.now() }
  } else {
    const parent = findContour(p, parentId)!.contour
    if (contourFingerprint(parent.points, parent.closed) === childFp) return false
    nesting.byFp[childFp] = {
      parentFp: contourFingerprint(parent.points, parent.closed),
      at: Date.now(),
    }
  }
  recomputeProject(p, true)
  touch(p)
  return true
}

/** 撤销单条人工判定，恢复自动 */
export function resetContourNesting(p: Project, contourId: string): void {
  const hit = findContour(p, contourId)
  if (!hit?.shape.nesting) return
  const fp = contourFingerprint(hit.contour.points, hit.contour.closed)
  if (fp in hit.shape.nesting.byFp) {
    delete hit.shape.nesting.byFp[fp]
    recomputeProject(p, true)
    touch(p)
  }
}

/** 清空当前形状（或整个项目）的人工层级判定 */
export function resetAllNesting(p: Project, shapeId?: string): void {
  let changed = false
  for (const s of p.shapes) {
    if (shapeId && s.id !== shapeId) continue
    if (s.nesting && Object.keys(s.nesting.byFp).length > 0) {
      s.nesting = { byFp: {} }
      changed = true
    }
  }
  if (changed) {
    recomputeProject(p, true)
    touch(p)
  }
}

/**
 * 重新导入同一份图后继承人工判定：
 * 在项目已有的全部形状里按几何指纹找「子轮廓 → 指定父轮廓」，
 * 父子指纹都在新形状中出现才继承；子同指纹有多个时取代表点落在指定父内的那个。
 * 返回继承的判定条数。
 */
export function carryNestingOverrides(p: Project, shape: Shape): number {
  const oldEntries: Array<{ childFp: string; parentFp: string | null; at: number }> = []
  for (const s of p.shapes) {
    if (!s.nesting) continue
    for (const [fp, m] of Object.entries(s.nesting.byFp)) {
      oldEntries.push({ childFp: fp, parentFp: m.parentFp, at: m.at })
    }
  }
  if (oldEntries.length === 0) return 0

  const newItems = shape.contours.map((c) => ({
    c,
    fp: contourFingerprint(c.points, c.closed),
  }))
  const newFps = new Set(newItems.map((x) => x.fp))
  const nesting = ensureNesting(shape)
  let carried = 0
  for (const e of oldEntries) {
    if (!newFps.has(e.childFp)) continue
    if (e.parentFp !== null && !newFps.has(e.parentFp)) continue
    const children = newItems.filter((x) => x.fp === e.childFp)
    let chosen = children[0]
    if (children.length > 1 && e.parentFp !== null) {
      // 同指纹多个子（重复/对称）：选代表点落在指定父轮廓内的那个
      const parents = newItems.filter((x) => x.fp === e.parentFp)
      const inside = children.find((ch) =>
        parents.some((par) => ch.c.closed && pointInsideLazy(ch.c, par.c)),
      )
      if (inside) chosen = inside
    }
    if (!chosen) continue
    nesting.byFp[e.childFp] = { parentFp: e.parentFp, at: e.at }
    carried += 1
  }
  if (Object.keys(nesting.byFp).length === 0) shape.nesting = undefined
  return carried
}

/** 纹样对称生成：镜像 / 旋转 / 四方连续 */
export function applySymmetry(p: Project, shapeId: string, op: 'mirror_x' | 'mirror_y' | 'rotate_90' | 'rotate_180' | 'four_way'): void {
  const shape = p.shapes.find((s) => s.id === shapeId)
  if (!shape) return
  const all = shape.contours.flatMap((c) => c.points)
  if (all.length === 0) return
  const minX = Math.min(...all.map((q) => q.x))
  const maxX = Math.max(...all.map((q) => q.x))
  const minY = Math.min(...all.map((q) => q.y))
  const maxY = Math.max(...all.map((q) => q.y))

  const makeCopy = (fn: (x: number, y: number) => { x: number; y: number }): Shape => {
    const contours = shape.contours.map((c) => {
      const pts = c.points.map((q) => {
        const r = fn(q.x, q.y)
        return { x: Math.round(r.x * 1000) / 1000, y: Math.round(r.y * 1000) / 1000 }
      })
      return { ...c, id: uid('c'), points: pts, holes: [], bridges: [], warnings: [] }
    })
    return { id: uid('s'), name: `${shape.name} 对称`, contours, layer: shape.layer }
  }

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const ops: Array<(x: number, y: number) => { x: number; y: number }> = []
  if (op === 'mirror_x') ops.push((x, y) => ({ x: minX + maxX - x, y }))
  if (op === 'mirror_y') ops.push((x, y) => ({ x, y: minY + maxY - y }))
  if (op === 'rotate_90') ops.push((x, y) => ({ x: cx - (y - cy), y: cy + (x - cx) }))
  if (op === 'rotate_180') ops.push((x, y) => ({ x: 2 * cx - x, y: 2 * cy - y }))
  if (op === 'four_way') {
    ops.push((x, y) => ({ x: minX + maxX - x, y }))
    ops.push((x, y) => ({ x, y: minY + maxY - y }))
    ops.push((x, y) => ({ x: minX + maxX - x, y: minY + maxY - y }))
  }
  for (const fn of ops) p.shapes.push(makeCopy(fn))
  recomputeProject(p, true)
  touch(p)
}

// ---------------- 材料预设 ----------------

export function upsertMaterial(m: MaterialPreset): void {
  const i = state.materials.findIndex((x) => x.id === m.id)
  if (i >= 0) state.materials[i] = { ...m }
  else state.materials.push({ ...m })
  scheduleSave()
}

export function deleteMaterial(id: string): void {
  const i = state.materials.findIndex((x) => x.id === id)
  if (i >= 0 && state.materials.length > 1) {
    state.materials.splice(i, 1)
    for (const p of state.projects) {
      if (p.materialId === id) {
        p.materialId = state.materials[0].id
        recomputeProject(p, true)
      }
    }
    scheduleSave()
  }
}

// ---------------- 导入 ----------------

export function importSvgToShapes(
  text: string,
  name: string,
  settings: CutSettings,
): { result: ImportResult; shape: Shape } {
  const result = importSvgText(text, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
  const shape: Shape = { id: uid('s'), name, contours: result.contours, layer: 0 }
  return { result, shape }
}

export function addImportedShapes(p: Project, shapes: Shape[]): number {
  let carried = 0
  for (const s of shapes) {
    carried += carryNestingOverrides(p, s)
    p.shapes.push(s)
  }
  recomputeProject(p, true)
  touch(p)
  return carried
}

watch(
  () => [state.projects, state.materials],
  () => {
    if (state.ready) scheduleSave()
  },
  { deep: true },
)

export const store = {
  state,
  loadState,
  saveNow,
  scheduleSave,
  materialOf,
  getProject,
  computedOf,
  jobOf,
  layerOrderOf,
  createProjectFromShapes,
  createBlankProject,
  deleteProject,
  duplicateProject,
  addShape,
  addImportedShapes,
  removeShape,
  updateSettings,
  updateExport,
  updateSheet,
  updateBatch,
  setMaterial,
  closeAllOpen,
  closeContour,
  removeContour,
  placeManualBridge,
  clearManualBridges,
  setContourParent,
  resetContourNesting,
  resetAllNesting,
  canSetParent,
  carryNestingOverrides,
  applySymmetry,
  upsertMaterial,
  deleteMaterial,
  recomputeProject,
  recomputeAll,
  importSvgToShapes,
  touch,
}