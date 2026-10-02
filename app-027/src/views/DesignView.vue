<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PreviewCanvas from '@/components/PreviewCanvas.vue'
import { store, state } from '@/logic/store'
import { PATTERN_LIBRARY, fetchPatternText } from '@/data/patterns'
import type { Contour, ContourWarning, Pt, Shape } from '@/logic/types'
import type { ComputedShape } from '@/logic/pipeline'
import { makeContour } from '@/logic/cleanup'
import { dist, uid } from '@/logic/geometry'
import { arcToCubics, sampleCubicInto } from '@/logic/svg'

type Mode = 'outline' | 'toolpath' | 'bridge'
type Tool = 'select' | 'pan' | 'rect' | 'circle' | 'polygon' | 'bridge'
type SymOp = 'mirror_x' | 'mirror_y' | 'rotate_90' | 'rotate_180' | 'four_way'

const route = useRoute()
const router = useRouter()
const canvas = ref<InstanceType<typeof PreviewCanvas> | null>(null)

const projectId = computed(() => String(route.params.id))
const project = computed(() => store.getProject(projectId.value) ?? null)

const tool = ref<Tool>('select')
const mode = ref<Mode>('outline')
const selectedShapeId = ref<string>('')
const selectedContourId = ref<string | null>(null)
const cursorPt = ref<Pt>({ x: 0, y: 0 })
const busy = ref('')
const error = ref('')
const notice = ref('')
const showProblems = ref(true)
const showRules = ref(true)
const showContour = ref(true)

watch(
  project,
  (p) => {
    if (p && p.shapes.length > 0 && !p.shapes.some((s) => s.id === selectedShapeId.value)) {
      selectedShapeId.value = p.shapes[0].id
    }
    if (p && !p.batchShapeId && p.shapes.length > 0) p.batchShapeId = p.shapes[0].id
  },
  { immediate: true },
)

const shapes = computed(() => project.value?.shapes ?? [])
const selectedShape = computed(() => shapes.value.find((s) => s.id === selectedShapeId.value) ?? null)
const selectedContour = computed<Contour | null>(() => {
  if (!selectedContourId.value) return null
  for (const s of shapes.value) {
    const c = s.contours.find((x) => x.id === selectedContourId.value)
    if (c) return c
  }
  return null
})

const computedOfSelected = computed(() => {
  if (!selectedShape.value) return null
  return store.computedOf(selectedShape.value.id)
})

// ---------------- 包含关系核对表 ----------------

const showNesting = ref(true)

type NestingRow = {
  idx: number
  id: string
  label: string
  closed: boolean
  areaMm2: number
  depth: number
  parentId: string | null
  parentLabel: string
  autoParentLabel: string
  manual: boolean
  manualIssue: string | null
  doubts: { text: string; kind: string }[]
  repEdgeMm: number | null
  boundaryGapMm: number | null
  offsetDir: string
  cutSeq: number | null
}

/** 轮廓在形状内的稳定序号（#1 起） */
function contourIndexMap(shape: Shape | null): Map<string, number> {
  const m = new Map<string, number>()
  shape?.contours.forEach((c, i) => m.set(c.id, i + 1))
  return m
}

const nestingRows = computed<NestingRow[]>(() => {
  const shape = selectedShape.value
  const comp = computedOfSelected.value
  if (!shape || !comp) return []
  const idxMap = contourIndexMap(shape)
  const labelOf = (id: string | null): string => {
    if (!id) return '— 顶层 —'
    const i = idxMap.get(id)
    return i ? `#${i}` : '（已删除）'
  }
  // 切割顺序号：该轮廓第一段在整体顺序里的序号
  const seqOf = new Map<string, number>()
  comp.order.steps.forEach((st, i) => {
    if (!seqOf.has(st.contourId)) seqOf.set(st.contourId, i + 1)
  })
  return shape.contours.map((c, i) => {
    const info = comp.tree.infoById.get(c.id)
    const depth = info?.depth ?? 1
    return {
      idx: i + 1,
      id: c.id,
      label: `#${i + 1}`,
      closed: c.closed,
      areaMm2: c.area,
      depth,
      parentId: info?.parentId ?? null,
      parentLabel: labelOf(info?.parentId ?? null),
      autoParentLabel: labelOf(info?.autoParentId ?? null),
      manual: info?.manual ?? false,
      manualIssue: info?.manualIssue ?? null,
      doubts: (info?.doubts ?? []).map((d) => ({ text: d.text, kind: d.kind })),
      repEdgeMm: info?.repEdgeDistMm ?? null,
      boundaryGapMm: info?.boundaryGapMm ?? null,
      offsetDir: !c.closed ? '不刀补' : depth % 2 === 1 ? '向外' : '向内',
      cutSeq: seqOf.get(c.id) ?? null,
    }
  })
})

const doubtfulCount = computed(() => nestingRows.value.filter((r) => r.doubts.length > 0).length)
const manualCountSelected = computed(() => nestingRows.value.filter((r) => r.manual).length)
const netAreaSelected = computed(() => computedOfSelected.value?.stats.netAreaMm2 ?? 0)

/** 可作为某条轮廓父级的候选：闭合、不是自己、面积/包含关系不限制（用户可能强行指定），环由 store 校验 */
const parentOptions = computed(() => {
  const shape = selectedShape.value
  if (!shape) return []
  return shape.contours
    .map((c, i) => ({ id: c.id, label: `#${i + 1}`, closed: c.closed, area: c.area }))
})

function selectRow(row: NestingRow): void {
  if (selectedShape.value) onSelectContour(row.id, selectedShape.value.id)
  canvas.value?.focusContour(row.id)
}

function assignParent(row: NestingRow, raw: string): void {
  const p = project.value
  const shape = selectedShape.value
  if (!p || !shape) return
  if (raw === '__auto__') {
    store.resetManualParent(p, shape.id, row.id)
    return
  }
  const parentId = raw === '__root__' ? null : raw
  const res = store.setManualParent(p, shape.id, row.id, parentId)
  if (!res.ok) error.value = res.reason ?? '指定失败'
  else error.value = ''
}

function resetRow(row: NestingRow): void {
  const p = project.value
  const shape = selectedShape.value
  if (!p || !shape) return
  store.resetManualParent(p, shape.id, row.id)
  error.value = ''
}

function resetAllNesting(): void {
  const p = project.value
  const shape = selectedShape.value
  if (!p || !shape) return
  const n = store.resetAllManualParents(p, shape.id)
  error.value = n === 0 ? '这个形状没有人工判定' : `已恢复 ${n} 条为自动判定`
}

const doubtShort: Record<string, string> = {
  area_close: '面积接近',
  boundary_near: '贴边',
  rep_near_edge: '代表点贴边',
  nearby_open_frame: '附近断框',
  overlap_ambiguous: '候选重叠',
  manual_cycle_rejected: '成环拒绝',
  manual_missing_parent: '父级缺失',
}

const selectedNestingDoubts = computed<string[]>(() => {
  const row = nestingRows.value.find((r) => r.id === selectedContourId.value)
  return row ? row.doubts.map((d) => d.text) : []
})

const selectedNesting = computed(() => {
  if (!selectedContourId.value || !computedOfSelected.value) return null
  return computedOfSelected.value.tree.infoById.get(selectedContourId.value) ?? null
})

function indexOfContour(id: string | null | undefined): number | null {
  if (!id || !selectedShape.value) return null
  const i = selectedShape.value.contours.findIndex((c) => c.id === id)
  return i >= 0 ? i + 1 : null
}

const selectedContourParentIndex = computed(() => indexOfContour(selectedNesting.value?.parentId))
const selectedAutoParentIndex = computed(() => indexOfContour(selectedNesting.value?.autoParentId))

const totalStats = computed(() => {
  let contours = 0
  let closed = 0
  let open = 0
  let bridges = 0
  let cutLen = 0
  let travel = 0
  let naive = 0
  let ms = 0
  let fragments = 0
  let maxDepth = 1
  let dev = 0
  let doubtful = 0
  let manualNesting = 0
  for (const s of shapes.value) {
    const c = store.computedOf(s.id)
    if (!c) continue
    contours += c.stats.contourCount
    closed += c.stats.closedCount
    open += c.stats.openCount
    bridges += c.stats.bridgeCount
    fragments += c.stats.fragmentCount
    cutLen += c.stats.cutLengthMm
    travel += c.stats.travelMm
    naive += c.stats.naiveTravelMm
    ms += c.elapsedMs
    maxDepth = Math.max(maxDepth, c.stats.maxDepth)
    dev = Math.max(dev, c.stats.geometryDeviationMm)
    doubtful += c.stats.doubtfulCount
    manualNesting += c.stats.manualNestingCount
  }
  return {
    contours,
    closed,
    open,
    bridges,
    fragments,
    cutLen,
    travel,
    naive,
    ms,
    maxDepth,
    dev,
    doubtful,
    manualNesting,
    improve: naive > 1e-9 ? ((naive - travel) / naive) * 100 : 0,
  }
})

type Problem = { id: string; shapeId: string; contourId: string; kind: ContourWarning; text: string; level: 'err' | 'warn' | 'info' }

const problems = computed<Problem[]>(() => {
  const out: Problem[] = []
  for (const s of shapes.value) {
    const comp = store.computedOf(s.id)
    for (const c of s.contours) {
      for (const w of c.warnings) {
        if (w === 'not_closed') {
          const gap = c.points.length >= 2 ? dist(c.points[0], c.points[c.points.length - 1]) : 0
          out.push({
            id: `${c.id}-nc`,
            shapeId: s.id,
            contourId: c.id,
            kind: w,
            text: `未闭合：首尾相距 ${gap.toFixed(2)}mm（容差 ${project.value?.settings.closeToleranceMm}mm），切不穿`,
            level: 'err',
          })
        } else if (w === 'self_intersect') {
          out.push({
            id: `${c.id}-si`,
            shapeId: s.id,
            contourId: c.id,
            kind: w,
            text: `自交：路径与自身相交，交点处切不干净`,
            level: 'err',
          })
        } else if (w === 'duplicate') {
          out.push({ id: `${c.id}-dp`, shapeId: s.id, contourId: c.id, kind: w, text: '重复路径：存在完全重叠/反向重叠的路径，已合并只切一次', level: 'warn' })
        } else if (w === 'offset_failed') {
          out.push({ id: `${c.id}-of`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补偏置失败，已保留原路径', level: 'err' })
        } else if (w === 'offset_clipped') {
          out.push({ id: `${c.id}-oc`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补在凹角产生自交，已裁剪', level: 'info' })
        } else if (w === 'bridge_degraded') {
          out.push({
            id: `${c.id}-bd`,
            shapeId: s.id,
            contourId: c.id,
            kind: w,
            text: comp?.byId.get(c.id)?.bridgeMetrics.reason || '轮廓过短，连刀点宽度已削窄',
            level: 'warn',
          })
        }
      }
    }
  }
  return out
})

function locate(p: Problem): void {
  selectedShapeId.value = p.shapeId
  selectedContourId.value = p.contourId
  canvas.value?.focusContour(p.contourId)
}

function onSelectContour(id: string, shapeId: string): void {
  selectedContourId.value = id
  selectedShapeId.value = shapeId
}

function mutate(fn: () => void): void {
  const p = project.value
  if (!p) return
  fn()
  store.recomputeProject(p, true)
  store.touch(p)
}

function drawingTargetShape(): Shape {
  const p = project.value as NonNullable<typeof project.value>
  const cur = selectedShape.value
  if (cur && cur.name.startsWith('绘图')) return cur
  const s: Shape = { id: uid('s'), name: `绘图 ${p.shapes.filter((x) => x.name.startsWith('绘图')).length + 1}`, contours: [], layer: cur?.layer ?? 0 }
  p.shapes.push(s)
  selectedShapeId.value = s.id
  return s
}

function onRect(r: { x: number; y: number; w: number; h: number }): void {
  mutate(() => {
    const s = drawingTargetShape()
    s.contours.push(
      makeContour(
        [
          { x: r.x, y: r.y },
          { x: r.x + r.w, y: r.y },
          { x: r.x + r.w, y: r.y + r.h },
          { x: r.x, y: r.y + r.h },
        ],
        true,
      ),
    )
  })
}

function circlePoints(cx: number, cy: number, r: number, tol = 0.1): Pt[] {
  const pts: Pt[] = []
  const cubics = [...arcToCubics(cx + r, cy, r, r, 0, true, true, cx - r, cy), ...arcToCubics(cx - r, cy, r, r, 0, true, true, cx + r, cy)]
  let cur: Pt = { x: cx + r, y: cy }
  for (const [c1, c2, end] of cubics) {
    sampleCubicInto(cur, c1, c2, end, tol, pts)
    cur = end
  }
  return pts
}

function onCircle(c: { cx: number; cy: number; r: number }): void {
  mutate(() => {
    const s = drawingTargetShape()
    s.contours.push(makeContour(circlePoints(c.cx, c.cy, c.r), true))
  })
}

function onPolygon(p: Pt[]): void {
  mutate(() => {
    const s = drawingTargetShape()
    s.contours.push(makeContour(p, true))
  })
}

function onManualBridge(b: { contourId: string; atIndex: number }): void {
  const p = project.value
  if (!p) return
  store.placeManualBridge(p, b.contourId, b.atIndex)
}

async function addPattern(slug: string): Promise<void> {
  const p = project.value
  if (!p || !slug) return
  const entry = PATTERN_LIBRARY.find((x) => x.slug === slug)
  if (!entry) return
  busy.value = slug
  error.value = ''
  try {
    const text = await fetchPatternText(entry.file)
    const { shape } = store.importSvgToShapes(text, entry.name, p.settings)
    shape.layer = selectedShape.value?.layer ?? 0
    store.addShape(p, shape)
    selectedShapeId.value = shape.id
    const restored = store.manualParentCount(shape)
    if (restored > 0) notice.value = `已按图样指纹恢复 ${restored} 处人工父子判定（蓝色 ■ 标记），请到「包含关系核对」复核`
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

function applySym(op: SymOp): void {
  const p = project.value
  if (!p || !selectedShape.value) return
  store.applySymmetry(p, selectedShape.value.id, op)
}

function closeAll(): void {
  const p = project.value
  if (!p) return
  const n = store.closeAllOpen(p)
  error.value = n === 0 ? '没有可闭合的轮廓' : ''
}

function closeOne(): void {
  const p = project.value
  if (!p || !selectedContour.value) return
  if (!store.closeContour(p, selectedContour.value.id)) error.value = '该轮廓已闭合或点数不足（≥3 点才能闭合）'
  else error.value = ''
}

function delContour(): void {
  const p = project.value
  if (!p || !selectedContour.value) return
  store.removeContour(p, selectedContour.value.id)
  selectedContourId.value = null
}

function delShape(): void {
  const p = project.value
  if (!p || !selectedShape.value) return
  if (!confirm(`删除形状「${selectedShape.value.name}」？`)) return
  store.removeShape(p, selectedShape.value.id)
  selectedContourId.value = null
}

function setName(v: string): void {
  const p = project.value
  if (!p) return
  if (selectedShape.value) {
    selectedShape.value.name = v
    store.touch(p)
  } else {
    p.name = v
    store.touch(p)
  }
}

function addLayer(): void {
  const p = project.value
  if (!p) return
  const max = Math.max(...p.shapes.map((s) => s.layer), 0)
  if (selectedShape.value) {
    selectedShape.value.layer = max + 1
    store.recomputeProject(p, true)
    store.touch(p)
  }
}

const rule = computed(() => project.value?.settings.bridgeRule ?? 'by_area')
const settings = computed(() => project.value?.settings)

function patch(mut: (s: NonNullable<typeof settings.value>) => void): void {
  const p = project.value
  if (!p) return
  mut(p.settings)
  store.updateSettings(p, {})
}

const selMetrics = computed(() => {
  const c = selectedContour.value
  if (!c) return null
  const comp = computedOfSelected.value
  const m = comp?.byId.get(c.id)
  return m ?? null
})

const computedMap = computed(() => {
  const m = new Map<string, ComputedShape>()
  for (const s of shapes.value) {
    const c = store.computedOf(s.id)
    if (c) m.set(s.id, c)
  }
  return m
})
</script>

<template>
  <div v-if="!project" class="splash">项目不存在，请返回纹样库 <RouterLink to="/">返回</RouterLink></div>
  <div v-else class="workbench">
    <!-- 左：工具栏 -->
    <div class="panel">
      <div class="panel-head">工具</div>
      <div class="panel-body">
        <div class="tool-group">
          <button class="tool" :class="{ active: tool === 'select' }" @click="tool = 'select'"><span class="tool-icon">▶</span>选择 / 点选轮廓</button>
          <button class="tool" :class="{ active: tool === 'pan' }" @click="tool = 'pan'"><span class="tool-icon">✥</span>平移画布</button>
          <button class="tool" :class="{ active: tool === 'rect' }" @click="tool = 'rect'"><span class="tool-icon">▭</span>矩形</button>
          <button class="tool" :class="{ active: tool === 'circle' }" @click="tool = 'circle'"><span class="tool-icon">○</span>圆形</button>
          <button class="tool" :class="{ active: tool === 'polygon' }" @click="tool = 'polygon'"><span class="tool-icon">△</span>多边形</button>
          <button class="tool" :class="{ active: tool === 'bridge' }" @click="tool = 'bridge'"><span class="tool-icon">⌇</span>手工放连刀点</button>
        </div>
        <div class="hint">矩形/圆形：按住拖动绘制；多边形：逐点点击，回车或双击完成；手工连刀点：点击轮廓上的位置。</div>

        <div class="section">
          <div class="section-title">添加纹样</div>
          <select :value="''" @change="addPattern(($event.target as HTMLSelectElement).value)">
            <option value="">从内置纹样库添加…</option>
            <option v-for="p in PATTERN_LIBRARY" :key="p.slug" :value="p.slug">{{ p.category }}｜{{ p.name }}</option>
          </select>
          <div v-if="busy" class="hint">解析中…</div>
        </div>

        <div class="section">
          <div class="section-title">对称生成（选中形状）</div>
          <div class="btn-row">
            <button class="tiny" @click="applySym('mirror_x')">左右镜像</button>
            <button class="tiny" @click="applySym('mirror_y')">上下镜像</button>
            <button class="tiny" @click="applySym('rotate_90')">旋转 90°</button>
            <button class="tiny" @click="applySym('rotate_180')">旋转 180°</button>
            <button class="tiny" @click="applySym('four_way')">四方连续</button>
          </div>
        </div>

        <div class="section">
          <div class="section-title">图形列表</div>
          <div class="list">
            <div
              v-for="s in shapes"
              :key="s.id"
              class="list-item"
              :class="{ active: s.id === selectedShapeId }"
              @click="selectedShapeId = s.id"
            >
              <span class="grow">{{ s.name }}</span>
              <span class="tag">L{{ s.layer + 1 }}</span>
              <span class="tag">{{ s.contours.length }}</span>
            </div>
          </div>
          <div class="btn-row" style="margin-top: 6px">
            <button class="tiny" @click="delShape" :disabled="!selectedShape">删除形状</button>
            <button class="tiny" @click="addLayer" :disabled="!selectedShape">移到新图层</button>
          </div>
        </div>

        <div class="section">
          <div class="section-title">项目</div>
          <div class="field">
            <label>项目名</label>
            <input type="text" :value="project.name" @input="setName(($event.target as HTMLInputElement).value)" />
          </div>
          <div class="btn-row">
            <button class="tiny" @click="router.push(`/layout/${project.id}`)">进入排版</button>
            <button class="tiny" @click="router.push(`/export/${project.id}`)">进入导出</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 中：预览 -->
    <div class="panel canvas-panel">
      <div class="panel-head">
        <div class="mode-switch">
          <button :class="{ active: mode === 'outline' }" @click="mode = 'outline'">成品轮廓</button>
          <button :class="{ active: mode === 'toolpath' }" @click="mode = 'toolpath'">刀路 · 顺序</button>
          <button :class="{ active: mode === 'bridge' }" @click="mode = 'bridge'">连刀点放大 ×8</button>
        </div>
        <span class="spacer"></span>
        <span class="tag mono">光标 {{ cursorPt.x }}, {{ cursorPt.y }} mm</span>
      </div>
      <PreviewCanvas
        ref="canvas"
        :shapes="shapes"
        :computed="computedMap"
        :mode="mode"
        :tool="tool"
        :show-numbers="mode === 'toolpath'"
        :show-travel="mode === 'toolpath'"
        :magnify="true"
        :selected-contour-id="selectedContourId"
        :status-text="mode === 'bridge' ? '缺口已放大 8 倍' : ''"
        @select-contour="onSelectContour"
        @create-rect="onRect"
        @create-circle="onCircle"
        @create-polygon="onPolygon"
        @manual-bridge="onManualBridge"
        @cursor="cursorPt = $event"
      />
      <div class="panel-foot">
        <div class="legend">
          <span v-if="mode === 'outline'"><i style="background: #cfd9e4"></i>轮廓</span>
          <span><i style="background: #ffc857"></i>未闭合</span>
          <span><i style="background: #ff6b6b"></i>自交</span>
          <span><i style="background: #b48cff"></i>重复路径</span>
          <span v-if="mode === 'toolpath'"><i style="background: #ff8f3c"></i>刀路</span>
          <span v-if="mode === 'toolpath'"><i style="background: #7f8fa3"></i>跳刀</span>
          <span v-if="mode === 'bridge'"><i style="background: #47c07a"></i>连刀点缺口</span>
          <span><i style="background: #ffc857; transform: rotate(45deg); border-radius: 1px"></i>判定存疑</span>
          <span><i style="background: #5aa9ff; transform: rotate(45deg); border-radius: 1px"></i>人工父子</span>
        </div>
      </div>
    </div>

    <!-- 右：属性与规则 -->
    <div class="panel">
      <div class="panel-head">属性与规则</div>
      <div class="panel-body">
        <div v-if="error" class="banner err">{{ error }}</div>
        <div v-if="notice" class="banner ok">{{ notice }}</div>

        <div class="stat-grid">
          <div class="stat"><div class="k">轮廓 / 闭合</div><div class="v">{{ totalStats.contours }}<small>/{{ totalStats.closed }}</small></div></div>
          <div class="stat"><div class="k">未闭合</div><div class="v" :style="{ color: totalStats.open ? 'var(--err)' : '' }">{{ totalStats.open }}</div></div>
          <div class="stat"><div class="k">连刀点</div><div class="v">{{ totalStats.bridges }}</div></div>
          <div class="stat"><div class="k">刀路总长</div><div class="v">{{ totalStats.cutLen.toFixed(0) }}<small>mm</small></div></div>
          <div class="stat"><div class="k">跳刀 / 优化</div><div class="v">{{ totalStats.travel.toFixed(0) }}<small>mm · {{ totalStats.improve >= 0 ? '−' : '+' }}{{ Math.abs(totalStats.improve).toFixed(1) }}%</small></div></div>
          <div class="stat"><div class="k">嵌套层数</div><div class="v">{{ totalStats.maxDepth }}</div></div>
          <div class="stat"><div class="k">判定存疑</div><div class="v" :style="{ color: totalStats.doubtful ? 'var(--warn)' : '' }">{{ totalStats.doubtful }}</div></div>
          <div class="stat"><div class="k">人工判定</div><div class="v" :style="{ color: totalStats.manualNesting ? '#5aa9ff' : '' }">{{ totalStats.manualNesting }}</div></div>
          <div class="stat"><div class="k">几何偏差</div><div class="v">{{ totalStats.dev.toFixed(3) }}<small>mm</small></div></div>
          <div class="stat"><div class="k">计算耗时</div><div class="v">{{ totalStats.ms.toFixed(1) }}<small>ms</small></div></div>
        </div>

        <div class="section">
          <div class="section-title" @click="showProblems = !showProblems">
            问题清单
            <span class="tag" :class="problems.length ? 'err' : 'ok'">{{ problems.length }}</span>
            <span class="spacer"></span>
            <button class="tiny" @click.stop="closeAll">一键闭合未闭合轮廓</button>
          </div>
          <div v-show="showProblems">
            <div v-if="problems.length === 0" class="empty">未发现问题：路径闭合、无自交、无重复。</div>
            <div class="list">
              <div v-for="p in problems" :key="p.id" class="list-item" @click="locate(p)">
                <span class="tag" :class="p.level === 'err' ? 'err' : p.level === 'warn' ? 'warn' : 'info'">{{ p.kind }}</span>
                <span class="grow">{{ p.text }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title" @click="showNesting = !showNesting">
            包含关系核对
            <span class="tag" :class="doubtfulCount ? 'warn' : 'ok'">{{ doubtfulCount }} 存疑</span>
            <span v-if="manualCountSelected" class="tag" style="background: #2c4a66; color: #9fd0ff">{{ manualCountSelected }} 人工</span>
            <span class="spacer"></span>
            <button class="tiny" @click.stop="resetAllNesting" :disabled="manualCountSelected === 0">全部恢复自动</button>
          </div>
          <div v-show="showNesting">
            <div v-if="!selectedShape" class="empty">先在左侧选择一个形状</div>
            <template v-else-if="nestingRows.length === 0">
              <div class="empty">这个形状还没有轮廓</div>
            </template>
            <template v-else>
              <div class="hint nesting-hint">
                自动判定按「面积大 + 代表点落在内」认父子；
                <i class="mk doubt">◆</i> 存疑、<i class="mk man">■</i> 人工、<i class="mk bad">■</i> 人工失效。
                点行定位到画布；改父级后切割顺序、刀补方向、净面积立即重算，人工判定随图样指纹留痕，重新导入同一张 SVG 自动恢复。
              </div>
              <div class="stat-grid">
                <div class="stat"><div class="k">嵌套层数</div><div class="v">{{ computedOfSelected?.stats.maxDepth ?? 1 }}</div></div>
                <div class="stat"><div class="k">内层轮廓</div><div class="v">{{ computedOfSelected?.stats.nestedCount ?? 0 }}</div></div>
                <div class="stat"><div class="k">存疑 / 人工</div><div class="v">{{ doubtfulCount }}<small>/{{ manualCountSelected }}</small></div></div>
                <div class="stat"><div class="k">净面积</div><div class="v">{{ netAreaSelected.toFixed(1) }}<small>mm²</small></div></div>
              </div>
              <div class="nest-table-wrap">
                <table class="nest-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>层深</th>
                      <th>父级（生效 / 自动）</th>
                      <th>刀补</th>
                      <th>顺序</th>
                      <th>标记</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="r in nestingRows"
                      :key="r.id"
                      :class="{
                        selected: r.id === selectedContourId,
                        doubtful: r.doubts.length > 0,
                      }"
                      @click="selectRow(r)"
                    >
                      <td class="mono">
                        {{ r.label }}
                        <div class="hint" style="font-size: 10px">{{ r.closed ? `${r.areaMm2.toFixed(1)}mm²` : '未闭合' }}</div>
                      </td>
                      <td class="num depth-cell"><span class="depth-badge" :data-d="r.depth">{{ r.depth }}</span></td>
                      <td class="parent-cell">
                        <select
                          :value="r.manual ? (r.parentId ?? '__root__') : '__auto__'"
                          :disabled="!r.closed"
                          @click.stop
                          @change="assignParent(r, ($event.target as HTMLSelectElement).value)"
                        >
                          <option value="__auto__">自动{{ r.autoParentLabel !== '— 顶层 —' ? `（${r.autoParentLabel}）` : '（顶层）' }}</option>
                          <option value="__root__">置顶（顶层）</option>
                          <option v-for="opt in parentOptions.filter((o) => o.id !== r.id)" :key="opt.id" :value="opt.id" :disabled="!opt.closed">
                            {{ opt.label }}{{ opt.closed ? '' : '（未闭合不可）' }}
                          </option>
                        </select>
                        <div v-if="r.manual" class="hint manual-note">
                          <i class="mk man">■</i> 人工
                          <button class="linkbtn" @click.stop="resetRow(r)">恢复自动</button>
                        </div>
                        <div v-if="r.manualIssue" class="hint err-note">⚠ {{ r.manualIssue }}</div>
                      </td>
                      <td class="mono" :class="{ hole: r.offsetDir === '向内' }">{{ r.offsetDir }}</td>
                      <td class="num mono">{{ r.cutSeq ?? '—' }}</td>
                      <td>
                        <span v-for="(d, i) in r.doubts.slice(0, 3)" :key="i" class="doubt-chip" :title="d.text">
                          {{ doubtShort[d.kind] ?? d.kind }}
                        </span>
                        <span v-if="r.repEdgeMm !== null && r.repEdgeMm <= 0.3" class="hint" style="font-size: 10px; display: block">
                          点离边 {{ r.repEdgeMm.toFixed(2) }}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="selectedNestingDoubts.length" class="doubt-detail">
                <div v-for="(d, i) in selectedNestingDoubts" :key="i" class="hint">
                  <i class="mk doubt">◆</i> {{ d }}
                </div>
              </div>
            </template>
          </div>
        </div>

        <div class="section">
          <div class="section-title" @click="showContour = !showContour">
            选中轮廓
            <span class="spacer"></span>
            <button class="tiny" :disabled="!selectedContour" @click.stop="closeOne">闭合</button>
            <button class="tiny danger" :disabled="!selectedContour" @click.stop="delContour">删除</button>
          </div>
          <div v-show="showContour">
            <div v-if="!selectedContour" class="empty">在画布上点选一条轮廓</div>
            <template v-else>
              <div class="stat-grid">
                <div class="stat"><div class="k">点数</div><div class="v">{{ selectedContour.points.length }}</div></div>
                <div class="stat"><div class="k">面积</div><div class="v">{{ selectedContour.area.toFixed(2) }}<small>mm²</small></div></div>
                <div class="stat"><div class="k">周长</div><div class="v">{{ selectedContour.length.toFixed(2) }}<small>mm</small></div></div>
                <div class="stat"><div class="k">状态</div><div class="v" style="font-size: 12px">{{ selectedContour.closed ? '已闭合' : '未闭合' }}</div></div>
                <div class="stat"><div class="k">层深 / 父级</div><div class="v" style="font-size: 13px">{{ selectedNesting?.depth ?? 1 }}<small>/{{ selectedNesting?.parentId ? '#' + selectedContourParentIndex : '顶层' }}</small></div></div>
                <div class="stat"><div class="k">内层数</div><div class="v">{{ selectedContour.holes.length }}</div></div>
                <div class="stat"><div class="k">刀补方向</div><div class="v" style="font-size: 12px">{{ !selectedContour.closed ? '不刀补' : (selectedNesting?.depth ?? 1) % 2 === 1 ? '向外' : '向内' }}</div></div>
                <div class="stat"><div class="k">连刀点</div><div class="v">{{ selMetrics?.anchors.length ?? 0 }}</div></div>
              </div>
              <div v-if="selectedNesting" class="hint" style="margin-top: 6px">
                <span v-if="selectedNesting.manual"><i class="mk man">■</i> 人工判定（生效中）｜</span>
                <span v-else-if="selectedNesting.manualIssue"><i class="mk bad">■</i> 人工判定失效：{{ selectedNesting.manualIssue }}｜</span>
                自动判定父级：{{ selectedNesting.autoParentId ? '#' + selectedAutoParentIndex : '顶层' }}｜
                代表点离父边 {{ selectedNesting.repEdgeDistMm !== null ? selectedNesting.repEdgeDistMm.toFixed(2) + 'mm' : '—' }}
              </div>
              <div v-for="(d, i) in selectedNesting?.doubts ?? []" :key="i" class="hint doubt-line">
                <i class="mk doubt">◆</i> {{ d.text }}
              </div>
              <div v-if="selMetrics" class="hint" style="margin-top: 6px">
                {{ selMetrics.bridgeMetrics.reason }}｜几何偏差 {{ selMetrics.bridgeMetrics.geometryDeviationMm.toFixed(3) }}mm
              </div>
              <div v-if="selMetrics && selMetrics.anchors.length" class="bridge-list">
                <div v-for="(b, i) in selMetrics.anchors.slice(0, 30)" :key="i" class="mono">
                  #{{ i + 1 }} 锚点 ({{ b.at.x.toFixed(2) }}, {{ b.at.y.toFixed(2) }})｜宽 {{ b.widthMm.toFixed(3) }}mm
                </div>
              </div>
            </template>
          </div>
        </div>

        <div class="section" v-if="settings">
          <div class="section-title" @click="showRules = !showRules">切割规则</div>
          <div v-show="showRules">
            <div class="field-row">
              <label>连刀规则</label>
              <select :value="settings.bridgeRule" @change="patch((s) => (s.bridgeRule = ($event.target as HTMLSelectElement).value as never))">
                <option value="by_area">按片段面积（碎片必连刀）</option>
                <option value="by_length">按轮廓长度（每 L mm）</option>
                <option value="manual">手工放置</option>
              </select>
            </div>
            <div class="field-row">
              <label>面积阈值</label>
              <input type="number" step="0.5" min="0" :value="settings.areaThresholdMm2" @change="patch((s) => (s.areaThresholdMm2 = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm²</span>
            </div>
            <div class="field-row">
              <label>缺口宽度</label>
              <input type="number" step="0.05" min="0.1" max="2" :value="settings.bridgeWidthMm" @change="patch((s) => (s.bridgeWidthMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <div class="field-row">
              <label>每 L 一个</label>
              <input type="number" step="1" min="1" :value="settings.bridgeEveryMm" @change="patch((s) => (s.bridgeEveryMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <div class="field-row">
              <label>跳刀优化</label>
              <select :value="settings.travelOptimize" @change="patch((s) => (s.travelOptimize = ($event.target as HTMLSelectElement).value as never))">
                <option value="nearest_2opt">最近邻 + 2-opt</option>
                <option value="nearest">仅最近邻</option>
              </select>
            </div>
            <div class="field-row">
              <label>曲线容差</label>
              <input type="number" step="0.05" min="0.02" :value="settings.toleranceMm" @change="patch((s) => (s.toleranceMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <div class="field-row">
              <label>闭合容差</label>
              <input type="number" step="0.05" min="0.01" :value="settings.closeToleranceMm" @change="patch((s) => (s.closeToleranceMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <label class="check"><input type="checkbox" :checked="settings.useBladeOffset" @change="patch((s) => (s.useBladeOffset = ($event.target as HTMLInputElement).checked))" /> 启用刀补（刀偏置，凹角自交自动裁剪）</label>
            <div class="btn-row" style="margin-top: 6px">
              <button class="tiny" @click="rule === 'manual' ? store.clearManualBridges(project, selectedContourId ?? undefined) : null">
                清空手工连刀点
              </button>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">材料</div>
          <select :value="project.materialId" @change="store.setMaterial(project, ($event.target as HTMLSelectElement).value)">
            <option v-for="m in state.materials" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
          <div class="hint" style="margin-top: 5px">
            刀压 {{ store.materialOf(project)?.force }}｜速度 {{ store.materialOf(project)?.speedMmS }}mm/s｜重复 {{ store.materialOf(project)?.passes }} 次｜刀偏
            {{ store.materialOf(project)?.bladeOffsetMm }}mm
          </div>
          <div class="btn-row" style="margin-top: 6px">
            <button class="tiny" @click="router.push('/materials')">管理材料预设</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
  padding: 6px 8px;
  border-radius: 5px;
  margin-bottom: 8px;
  font-size: 12px;
}

.banner.ok {
  background: rgba(71, 192, 122, 0.12);
  border: 1px solid rgba(71, 192, 122, 0.4);
  color: #9fe0b8;
  padding: 6px 8px;
  border-radius: 5px;
  margin-bottom: 8px;
  font-size: 12px;
}

.section-title {
  cursor: pointer;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
}

.bridge-list {
  margin-top: 6px;
  max-height: 90px;
  overflow: auto;
  font-size: 11px;
  color: var(--text-mute);
  line-height: 1.7;
}

/* ---------------- 包含关系核对表 ---------------- */
.nesting-hint {
  margin: 4px 0 6px;
  line-height: 1.6;
}

.mk {
  font-style: normal;
  font-size: 11px;
  margin: 0 1px;
}
.mk.doubt {
  color: #ffc857;
}
.mk.man {
  color: #5aa9ff;
}
.mk.bad {
  color: #ff6b6b;
}

.nest-table-wrap {
  margin-top: 6px;
  max-height: 300px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 5px;
}

.nest-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}

.nest-table th {
  position: sticky;
  top: 0;
  background: var(--panel-2, #1b222b);
  text-align: left;
  padding: 4px 6px;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}

.nest-table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--line-soft, #232c37);
  vertical-align: top;
}

.nest-table tr.doubtful {
  background: rgba(255, 200, 87, 0.06);
}

.nest-table tr.selected {
  background: rgba(71, 192, 122, 0.1);
}

.nest-table tr:hover {
  cursor: pointer;
}

.nest-table .num {
  text-align: center;
}

.depth-badge {
  display: inline-block;
  min-width: 18px;
  padding: 0 4px;
  border-radius: 9px;
  text-align: center;
  background: #2a3340;
  color: #cfd9e4;
}
.depth-badge[data-d='2'] {
  background: #4a3a20;
  color: #ffc857;
}
.depth-badge[data-d='3'] {
  background: #3a2740;
  color: #d3a8ff;
}
.depth-badge[data-d='4'] {
  background: #20403a;
  color: #7fe0c8;
}

.parent-cell select {
  width: 100%;
  font-size: 11px;
  padding: 2px 3px;
}

.manual-note {
  margin-top: 2px;
  color: #9fd0ff;
}

.err-note {
  margin-top: 2px;
  color: #ffb3b3;
}

.linkbtn {
  background: none;
  border: none;
  padding: 0 0 0 4px;
  color: var(--accent, #5aa9ff);
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
}

.doubt-chip {
  display: inline-block;
  margin: 1px 2px 1px 0;
  padding: 0 5px;
  border-radius: 8px;
  background: rgba(255, 200, 87, 0.16);
  border: 1px solid rgba(255, 200, 87, 0.4);
  color: #ffd98a;
  font-size: 10px;
  white-space: nowrap;
}

.doubt-detail {
  margin-top: 5px;
  line-height: 1.7;
}

.doubt-line {
  color: #ffd98a;
  margin-top: 2px;
}

.depth-cell {
  text-align: center;
}

.hole {
  color: #ffc857;
}
</style>