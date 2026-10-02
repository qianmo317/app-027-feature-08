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
import { computeShape, manualNestingSignature, shapeSignature, type ComputedShape } from './pipeline'
import { buildBatchShape, buildJob, type Job } from './job'
import { uid } from './geometry'
import { importSvgText, type ImportResult } from './importer'
import {
  clearOverride,
  contourFingerprintMap,
  overridesForShape,
  recordOverride,
  shapeFingerprint,
} from './identity'
import { buildContainmentTree, type ManualParentMap } from './nesting'
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
/** 形状几何指纹缓存：key = shape.id|contourCount|轻量几何哈希 */
const shapeFpCache = new Map<string, { geoKey: string; shapeFp: string; fps: Map<string, string> }>()

/** 轻量几何 key：轮廓点变了才需要重算指纹 */
function geoKeyOf(shape: Shape): string {
  let h = 0
  let n = 0
  for (const c of shape.contours) {
    n += c.points.length
    for (const p of c.points) h = (h + p.x * 7.13 + p.y * 3.71) % 1e9
  }
  return `${shape.contours.length}:${n}:${Math.round(h * 1000)}`
}

/** 当前形状的指纹与「轮廓 id → 指纹」映射（带缓存） */
export function shapeIdentity(shape: Shape): { shapeFp: string; fps: Map<string, string> } {
  const geoKey = geoKeyOf(shape)
  const cached = shapeFpCache.get(shape.id)
  if (cached && cached.geoKey === geoKey) return { shapeFp: cached.shapeFp, fps: cached.fps }
  const fps = contourFingerprintMap(shape.contours)
  const shapeFp = shapeFingerprint(shape.contours)
  shapeFpCache.set(shape.id, { geoKey, shapeFp, fps })
  return { shapeFp, fps }
}

/** 解析台账中这张形状的人工父子判定（轮廓 id 映射） */
function manualParentsOf(shape: Shape): ManualParentMap {
  const { shapeFp, fps } = shapeIdentity(shape)
  return overridesForShape(shapeFp, fps)
}

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

function normalizeProject(p: Project): Project {
  return {
    ...p,
    settings: { ...DEFAULT_CUT_SETTINGS, ...(p.settings ?? {}) },
    export: { ...DEFAULT_EXPORT_CFG, ...(p.export ?? {}) },
    sheet: p.sheet ?? { ...DEFAULT_SHEET },
    shapes: (p.shapes ?? []).map((s) => ({
      ...s,
      contours: (s.contours ?? []).map((c) => ({ ...c, holes: c.holes ?? [], bridges: c.bridges ?? [], warnings: c.warnings ?? [] })),
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
    const manualParents = manualParentsOf(shape)
    const mSig = manualNestingSignature(manualParents)
    const cached = computedCache[shape.id]
    if (!force && cached && cached.signature === sig && manualNestingSignature(cached.manualParents) === mSig) continue
    const res = computeShape(shape, p.settings, material, { x: 0, y: 0 }, manualParents)
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
      const srcManual = manualParentsOf(src)
      const { shape: tiled, manualParents: tiledManual } = buildBatchShape(src, batch, srcManual)
      const sig =
        `batch|${shapeSignature(src, p.settings, material)}|${manualNestingSignature(srcManual)}` +
        `|${batch.rows}|${batch.cols}|${batch.gapXMm}|${batch.gapYMm}|${batch.mode}`
      let comp = batchCache.get(sig)
      if (!comp) {
        comp = computeShape(tiled, p.settings, material, start, tiledManual)
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
  // 重新分配 id，避免缓存串用
  for (const s of copy.shapes) {
    s.id = uid('s')
    for (const c of s.contours) c.id = uid('c')
    for (const c of s.contours) {
      c.holes = []
      c.bridges = []
    }
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
    shapeFpCache.delete(shapeId)
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

// ---------------- 包含关系（父子判定）人工覆盖 ----------------

/** 试探：把 contourId 指定为 parentId（null=置顶）会不会成环；返回 null=可行，否则为原因 */
export function checkManualParent(p: Project, shapeId: string, contourId: string, parentId: string | null): string | null {
  const shape = p.shapes.find((s) => s.id === shapeId)
  if (!shape) return '形状不存在'
  const contour = shape.contours.find((c) => c.id === contourId)
  if (!contour) return '轮廓不存在'
  if (!contour.closed) return '未闭合轮廓不参与内外层判定'
  if (parentId === null) return null
  if (parentId === contourId) return '不能把自身指定为父级'
  const parent = shape.contours.find((c) => c.id === parentId)
  if (!parent) return '父级轮廓不存在'
  if (!parent.closed) return '未闭合轮廓不能作为父级（外框断裂时请先一键闭合）'

  // 在「当前生效判定 + 本次修改」上做一次试构建，成环时树会拒绝
  const current = manualParentsOf(shape)
  const trial = new Map(current)
  trial.set(contourId, parentId)
  const result = buildContainmentTree(shape.contours, trial)
  const info = result.infoById.get(contourId)
  // 试构建会改写派生值 holes，恢复为当前真实判定
  buildContainmentTree(shape.contours, current)
  if (info?.manualIssue) return info.manualIssue
  return null
}

/** 指定父级（parentId=null 表示置顶）。校验失败返回 false 并给出原因，不写台账 */
export function setManualParent(
  p: Project,
  shapeId: string,
  contourId: string,
  parentId: string | null,
): { ok: boolean; reason?: string } {
  const reason = checkManualParent(p, shapeId, contourId, parentId)
  if (reason) return { ok: false, reason }
  const shape = p.shapes.find((s) => s.id === shapeId)
  if (!shape) return { ok: false, reason: '形状不存在' }
  const { shapeFp, fps } = shapeIdentity(shape)
  recordOverride(shapeFp, fps, contourId, parentId)
  recomputeProject(p, true)
  touch(p)
  return { ok: true }
}

/** 恢复自动判定（删除这条人工覆盖） */
export function resetManualParent(p: Project, shapeId: string, contourId: string): void {
  const shape = p.shapes.find((s) => s.id === shapeId)
  if (!shape) return
  const { shapeFp, fps } = shapeIdentity(shape)
  clearOverride(shapeFp, fps, contourId)
  recomputeProject(p, true)
  touch(p)
}

/** 清空这个形状的全部人工父子判定，返回清除条数 */
export function resetAllManualParents(p: Project, shapeId: string): number {
  const shape = p.shapes.find((s) => s.id === shapeId)
  if (!shape) return 0
  const { shapeFp, fps } = shapeIdentity(shape)
  const before = overridesForShape(shapeFp, fps).size
  for (const id of fps.keys()) clearOverride(shapeFp, fps, id)
  recomputeProject(p, true)
  touch(p)
  return before
}

/** 当前形状生效中的人工判定条数（核对表徽标用） */
export function manualParentCount(shape: Shape): number {
  return manualParentsOf(shape).size
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

export function addImportedShapes(p: Project, shapes: Shape[]): { restoredManualNesting: number[] } {
  for (const s of shapes) p.shapes.push(s)
  recomputeProject(p, true)
  touch(p)
  // 按指纹恢复的人工判定条数（让用户重新导入同一张图时能看到「哪几处是人工定的」）
  const restoredManualNesting = shapes.map((s) => manualParentsOf(s).size)
  return { restoredManualNesting }
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
  checkManualParent,
  setManualParent,
  resetManualParent,
  resetAllManualParents,
  manualParentCount,
  shapeIdentity,
  applySymmetry,
  upsertMaterial,
  deleteMaterial,
  recomputeProject,
  recomputeAll,
  importSvgToShapes,
  touch,
}