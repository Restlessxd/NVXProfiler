// =============================================================================
// Auto-Tree Profiler
//
// beginScope("a.b.c") pushes all 3 levels onto the stack
// Each endScope() closes one level (innermost first).
//
//   beginScope("core.animate.telemetry")
//   doWork1()     // measured under "telemetry"
//   endScope()    // closes telemetry → now inside "animate"
//   doWork2()     // measured under "animate"
//   endScope()    // closes animate → now inside "core"
//   doWork3()     // measured under "core"
//   endScope()    // closes core
//
// Overlay tabs: Real-time (live view) | Snapshot (record / export / import)
// =============================================================================

const PROFILING_ENABLED = true;

const MAX_TREE_NODES = 512;
const MAX_STACK = 64;
const HISTORY_FRAMES = 300;
const OVERLAY_UPDATE_INTERVAL = 200;

// GC detection thresholds
const GC_IDLE_SPIKE_FACTOR = 2.5;   // idle time must be N× higher than smoothed avg
const GC_MIN_IDLE_SPIKE_MS = 2;     // ignore tiny fluctuations
const GC_HEAP_DROP_BYTES = 1024 * 4096; // 4MB minimum heap drop for path B (concurrent GC)
const GC_COOLDOWN_FRAMES = 30;      // min frames between GC detections (~0.5s at 60fps)

// ---------------------------------------------------------------------------
// Tree node pool
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  fullPath: string;
  depth: number;
  startMs: number;
  endMs: number;
  totalMs: number;
  selfMs: number;
  percentage: number;
  callCount: number;
  parent: number;
  firstChild: number;
  nextSibling: number;
  avgMs: number;
  maxMs: number;
  minMs: number;
}

const nodes: TreeNode[] = [];
for (let i = 0; i < MAX_TREE_NODES; i++) {
  nodes[i] = {
    name: '', fullPath: '', depth: 0,
    startMs: 0, endMs: 0, totalMs: 0, selfMs: 0,
    percentage: 0, callCount: 0,
    parent: -1, firstChild: -1, nextSibling: -1,
    avgMs: 0, maxMs: 0, minMs: Infinity,
  };
}

const pathToIndex = new Map<string, number>();
let nodeCount = 0;

const scopeStack = new Int16Array(MAX_STACK);
let stackDepth = 0;

// ---------------------------------------------------------------------------
// FPS tracking — wall-clock between frames
// ---------------------------------------------------------------------------

let lastFrameWallTime = 0;
let wallClockDeltaMs = 16.6;
let lastWorkMs = 0;
let smoothedFps = 60;
const FPS_SMOOTHING = 0.05;

const frameTimesMs = new Float32Array(HISTORY_FRAMES);
const workTimesMs = new Float32Array(HISTORY_FRAMES);
let frameHistoryCursor = 0;
let frameCount = 0;

// ---------------------------------------------------------------------------
// GC heuristic detection state
// ---------------------------------------------------------------------------

let smoothedIdleMs = 8;          // EMA of idle time (frameDelta - workTime)
let lastHeapUsed = 0;            // previous frame heap snapshot
let gcSuspected = false;         // true if current frame looks like GC happened
let gcEstimatedMs = 0;           // estimated GC pause duration
let gcCount = 0;                 // total GC events detected this session
let gcLastFrame = -Infinity;     // frameCount when last GC was detected
const gcFrameFlags = new Uint8Array(HISTORY_FRAMES); // ring buffer: 1 = GC frame

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

function ensureRoot(): void {
  if (nodeCount > 0) return;
  const root = nodes[0];
  root.name = 'frame';
  root.fullPath = 'frame';
  root.depth = 0;
  root.parent = -1;
  root.firstChild = -1;
  root.nextSibling = -1;
  pathToIndex.set('frame', 0);
  nodeCount = 1;
}

function getOrCreateNode(
  name: string, fullPath: string, parentIdx: number, depth: number
): number {
  const existing = pathToIndex.get(fullPath);
  if (existing !== undefined) return existing;
  if (nodeCount >= MAX_TREE_NODES) return parentIdx;

  const idx = nodeCount++;
  const node = nodes[idx];
  node.name = name;
  node.fullPath = fullPath;
  node.depth = depth;
  node.parent = parentIdx;
  node.firstChild = -1;
  node.nextSibling = -1;
  node.callCount = 0;
  node.avgMs = 0;
  node.maxMs = 0;
  node.minMs = Infinity;

  pathToIndex.set(fullPath, idx);

  const p = nodes[parentIdx];
  if (p.firstChild === -1) {
    p.firstChild = idx;
  } else {
    let sib = p.firstChild;
    while (nodes[sib].nextSibling !== -1) sib = nodes[sib].nextSibling;
    nodes[sib].nextSibling = idx;
  }

  return idx;
}

// ---------------------------------------------------------------------------
// Core API — beginScope pushes ALL levels
// ---------------------------------------------------------------------------

function beginScopeImpl(path: string): void {
  ensureRoot();

  const now = performance.now();
  const parts = path.split('.');
  let parentIdx = 0;
  let currentPath = 'frame';

  for (let i = 0; i < parts.length; i++) {
    currentPath += '.' + parts[i];
    const nodeIdx = getOrCreateNode(parts[i], currentPath, parentIdx, i + 1);

    nodes[nodeIdx].startMs = now;
    nodes[nodeIdx].endMs = 0;

    if (stackDepth < MAX_STACK) {
      scopeStack[stackDepth] = nodeIdx;
      stackDepth++;
    }

    parentIdx = nodeIdx;
  }
}

function endScopeImpl(): void {
  if (stackDepth <= 1) return;

  stackDepth--;
  const nodeIdx = scopeStack[stackDepth];
  const node = nodes[nodeIdx];

  const now = performance.now();
  node.endMs = now;
  node.totalMs = now - node.startMs;
  node.selfMs = node.totalMs;
  node.callCount++;
  node.maxMs = Math.max(node.maxMs, node.totalMs);
  node.minMs = Math.min(node.minMs, node.totalMs);
  node.avgMs = node.avgMs * 0.95 + node.totalMs * 0.05;
}

function beginScopeNoop(_p: string): void {}
function endScopeNoop(): void {}

export const beginScope = PROFILING_ENABLED ? beginScopeImpl : beginScopeNoop;
export const endScope   = PROFILING_ENABLED ? endScopeImpl   : endScopeNoop;

// ---------------------------------------------------------------------------
// Convenience: profile() opens and closes all levels
// ---------------------------------------------------------------------------

export function profile<T>(path: string, fn: () => T): T {
  if (!PROFILING_ENABLED) return fn();
  beginScope(path);
  try { return fn(); }
  finally {
    const count = path.split('.').length;
    for (let i = 0; i < count; i++) endScope();
  }
}

export async function profileAsync<T>(path: string, fn: () => Promise<T>): Promise<T> {
  if (!PROFILING_ENABLED) return fn();
  beginScope(path);
  try { return await fn(); }
  finally {
    const count = path.split('.').length;
    for (let i = 0; i < count; i++) endScope();
  }
}

// ---------------------------------------------------------------------------
// Calculate self time (total - children)
// ---------------------------------------------------------------------------

function calculateSelfTime(): void {
  const frameTotal = nodes[0].totalMs || 1;

  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i];
    if (node.totalMs <= 0) continue;

    node.percentage = (node.totalMs / frameTotal) * 100;

    node.selfMs = node.totalMs;
    let ch = node.firstChild;
    while (ch !== -1) {
      if (nodes[ch].totalMs > 0) {
        node.selfMs -= nodes[ch].totalMs;
      }
      ch = nodes[ch].nextSibling;
    }
    if (node.selfMs < 0) node.selfMs = 0;
  }
}

// ---------------------------------------------------------------------------
// Frame lifecycle
// ---------------------------------------------------------------------------

export function beginFrame(): void {
  if (!PROFILING_ENABLED) return;
  ensureRoot();

  const now = performance.now();
  if (lastFrameWallTime > 0) {
    wallClockDeltaMs = now - lastFrameWallTime;
    smoothedFps = smoothedFps * (1 - FPS_SMOOTHING)
                + (1000 / wallClockDeltaMs) * FPS_SMOOTHING;

    // --- GC heuristic detection ---
    // Two independent detection paths:
    //   Path A: idle spike between frames (catches stop-the-world GC pauses)
    //   Path B: heap drop (catches concurrent GC with tiny main-thread pause)

    // lastWorkMs still holds PREVIOUS frame's work time here
    const idleMs = wallClockDeltaMs - lastWorkMs;
    const idleSpike = idleMs - smoothedIdleMs;

    const mem = typeof (performance as any).memory !== 'undefined' ? (performance as any).memory : null;
    const heapNow = mem ? mem.usedJSHeapSize as number : 0;
    const heapDrop = lastHeapUsed - heapNow;

    // Path A: idle time spiked significantly
    const pathA = idleSpike >= GC_MIN_IDLE_SPIKE_MS
      && idleMs >= Math.max(GC_MIN_IDLE_SPIKE_MS, smoothedIdleMs * GC_IDLE_SPIKE_FACTOR);

    // Path B: heap dropped significantly (concurrent GC finished between frames)
    const pathB = heapNow > 0 && lastHeapUsed > 0 && heapDrop >= GC_HEAP_DROP_BYTES;

    const cooldownOk = (frameCount - gcLastFrame) >= GC_COOLDOWN_FRAMES;
    gcSuspected = cooldownOk && (pathA || pathB);
    gcEstimatedMs = gcSuspected ? Math.max(0, idleSpike) : 0;
    if (gcSuspected) {
      gcCount++;
      gcLastFrame = frameCount;
      const reason = pathA && pathB ? 'idle+heap' : pathA ? 'idle spike' : 'heap drop';
      console.log(
        `[Profiler GC] #${frameCount} (${reason}) | idle: ${idleMs.toFixed(2)}ms (avg: ${smoothedIdleMs.toFixed(2)}ms, spike: +${idleSpike.toFixed(2)}ms) | heap: ${heapNow > 0 ? (heapNow/1048576).toFixed(1)+'MB' : 'N/A'} drop: ${(heapDrop/1024).toFixed(0)}KB`
      );
    }

    smoothedIdleMs = smoothedIdleMs * 0.9 + idleMs * 0.1;
    lastHeapUsed = heapNow;
  }
  lastFrameWallTime = now;

  for (let i = 0; i < nodeCount; i++) {
    nodes[i].startMs = 0;
    nodes[i].endMs = 0;
    nodes[i].totalMs = 0;
    nodes[i].selfMs = 0;
    nodes[i].percentage = 0;
  }

  stackDepth = 0;
  nodes[0].startMs = now;
  scopeStack[0] = 0;
  stackDepth = 1;
}

export function endFrame(): void {
  if (!PROFILING_ENABLED) return;

  while (stackDepth > 1) endScope();

  stackDepth = 0;
  const root = nodes[0];
  root.endMs = performance.now();
  root.totalMs = root.endMs - root.startMs;
  root.callCount++;
  root.maxMs = Math.max(root.maxMs, root.totalMs);
  root.minMs = Math.min(root.minMs, root.totalMs);
  root.avgMs = root.avgMs * 0.95 + root.totalMs * 0.05;

  lastWorkMs = root.totalMs;

  const cursor = frameHistoryCursor % HISTORY_FRAMES;
  frameTimesMs[cursor] = wallClockDeltaMs;
  workTimesMs[cursor] = lastWorkMs;
  gcFrameFlags[cursor] = gcSuspected ? 1 : 0;
  frameHistoryCursor++;
  frameCount++;

  calculateSelfTime();

  if (recording) {
    recordedFrames.push(captureFrameSnapshot());
  }
}

// ---------------------------------------------------------------------------
// Tree output (DFS walk)
// ---------------------------------------------------------------------------

export interface FlatNode {
  index: number;
  name: string;
  fullPath: string;
  depth: number;
  totalMs: number;
  selfMs: number;
  percentage: number;
  callCount: number;
  avgMs: number;
  maxMs: number;
  hasChildren: boolean;
}

const flatResult: FlatNode[] = [];

function walkDFS(idx: number, out: FlatNode[]): void {
  const n = nodes[idx];
  if (n.totalMs <= 0 && idx !== 0) return;

  out.push({
    index: idx, name: n.name, fullPath: n.fullPath,
    depth: n.depth, totalMs: n.totalMs, selfMs: n.selfMs,
    percentage: n.percentage, callCount: n.callCount,
    avgMs: n.avgMs, maxMs: n.maxMs,
    hasChildren: n.firstChild !== -1,
  });

  let ch = n.firstChild;
  while (ch !== -1) { walkDFS(ch, out); ch = nodes[ch].nextSibling; }
}

export function getCallTree(): FlatNode[] {
  flatResult.length = 0;
  if (nodeCount === 0) return flatResult;
  walkDFS(0, flatResult);
  return flatResult;
}

export function getHotScopes(topN = 10): FlatNode[] {
  return getCallTree()
    .filter(n => n.depth > 0)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getFrameDeltaMs(): number { return wallClockDeltaMs; }
export function getWorkMs(): number { return lastWorkMs; }
export function getFps(): number { return Math.round(smoothedFps); }
export function isGcSuspected(): boolean { return gcSuspected; }
export function getGcEstimatedMs(): number { return gcEstimatedMs; }
export function getGcCount(): number { return gcCount; }
export function getCpuUtilization(): number {
  return wallClockDeltaMs > 0 ? Math.min(100, (lastWorkMs / wallClockDeltaMs) * 100) : 0;
}
export function getFrameCount(): number { return frameCount; }

export function getAverageFrameMs(count = 60): number {
  let sum = 0, c = 0;
  const start = Math.max(0, frameHistoryCursor - count);
  for (let i = start; i < frameHistoryCursor; i++) {
    const ms = frameTimesMs[i % HISTORY_FRAMES];
    if (ms > 0) { sum += ms; c++; }
  }
  return c > 0 ? sum / c : 0;
}

export function getP99FrameMs(count = 300): number {
  const f: number[] = [];
  const start = Math.max(0, frameHistoryCursor - count);
  for (let i = start; i < frameHistoryCursor; i++) {
    const ms = frameTimesMs[i % HISTORY_FRAMES];
    if (ms > 0) f.push(ms);
  }
  if (f.length === 0) return 0;
  f.sort((a, b) => a - b);
  return f[Math.floor(f.length * 0.99)] ?? f[f.length - 1];
}

export function getFrameHistory(count: number): Float32Array {
  const r = new Float32Array(count);
  const start = Math.max(0, frameHistoryCursor - count);
  for (let i = 0; i < count; i++) r[i] = frameTimesMs[(start + i) % HISTORY_FRAMES];
  return r;
}

export function getScopeMs(path: string): number {
  const idx = pathToIndex.get('frame.' + path);
  return idx !== undefined ? nodes[idx].totalMs : 0;
}

export function getScopeAvgMs(path: string): number {
  const idx = pathToIndex.get('frame.' + path);
  return idx !== undefined ? nodes[idx].avgMs : 0;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function getMemoryUsage() {
  if (typeof (performance as any).memory === 'undefined') return null;
  const m = (performance as any).memory;
  return {
    heapUsed: m.usedJSHeapSize,
    heapTotal: m.totalJSHeapSize,
    heapLimit: m.jsHeapSizeLimit,
  };
}

// ---------------------------------------------------------------------------
// Text report
// ---------------------------------------------------------------------------

export function getTextReport(): string {
  const tree = getCallTree();
  if (tree.length === 0) return 'No data';
  const lines: string[] = [];
  lines.push(
    `Frame #${frameCount} | ${getFps()} fps (${wallClockDeltaMs.toFixed(1)}ms) | ` +
    `work ${lastWorkMs.toFixed(1)}ms | Thread ${getCpuUtilization().toFixed(0)}%`
  );
  lines.push('\u2500'.repeat(64));
  for (const n of tree) {
    const indent = '  '.repeat(n.depth);
    lines.push(
      `${indent}${n.name.padEnd(24 - n.depth * 2)}` +
      `${n.totalMs.toFixed(2).padStart(7)}ms ` +
      `self ${n.selfMs.toFixed(2).padStart(6)}ms ` +
      `${n.percentage.toFixed(0).padStart(3)}%`
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Recording — capture frame snapshots for later analysis
// ---------------------------------------------------------------------------

export interface FrameSnapshot {
  frameNumber: number;
  timestamp: number;
  fps: number;
  frameDeltaMs: number;
  workMs: number;
  cpuUtilization: number;
  memory: { heapUsed: number; heapTotal: number; heapLimit: number } | null;
  tree: FlatNode[];
  gcSuspected: boolean;
  gcEstimatedMs: number;
}

export interface RecordingSession {
  version: number;
  startedAt: string;
  endedAt: string;
  totalFrames: number;
  avgFps: number;
  avgFrameMs: number;
  p99FrameMs: number;
  frames: FrameSnapshot[];
  summary: SummaryNode[];
}

export interface SummaryNode {
  name: string;
  fullPath: string;
  depth: number;
  totalMs: number;
  selfMs: number;
  percentage: number;
  callCount: number;
  avgMs: number;
  maxMs: number;
  minMs: number;
  hasChildren: boolean;
}

let recording = false;
let recordingStartTime = '';
let recordedFrames: FrameSnapshot[] = [];

function captureFrameSnapshot(): FrameSnapshot {
  const tree = getCallTree();
  return {
    frameNumber: frameCount,
    timestamp: performance.now(),
    fps: getFps(),
    frameDeltaMs: wallClockDeltaMs,
    workMs: lastWorkMs,
    cpuUtilization: getCpuUtilization(),
    memory: getMemoryUsage(),
    tree: tree.map(n => ({ ...n })),
    gcSuspected,
    gcEstimatedMs,
  };
}

export function startRecording(): void {
  recording = true;
  recordedFrames = [];
  recordingStartTime = new Date().toISOString();
}

export function stopRecording(): RecordingSession {
  recording = false;
  return buildSession(recordedFrames, recordingStartTime, new Date().toISOString());
}

export function isRecording(): boolean { return recording; }
export function getRecordedFrameCount(): number { return recordedFrames.length; }

// ---------------------------------------------------------------------------
// Summary — aggregate all frames into one tree
// ---------------------------------------------------------------------------

function buildSummary(frames: FrameSnapshot[]): SummaryNode[] {
  if (frames.length === 0) return [];

  const map = new Map<string, SummaryNode>();

  for (const frame of frames) {
    for (const n of frame.tree) {
      let s = map.get(n.fullPath);
      if (!s) {
        s = {
          name: n.name, fullPath: n.fullPath, depth: n.depth,
          totalMs: 0, selfMs: 0, percentage: 0,
          callCount: 0, avgMs: 0, maxMs: 0, minMs: Infinity,
          hasChildren: n.hasChildren,
        };
        map.set(n.fullPath, s);
      }
      s.totalMs += n.totalMs;
      s.selfMs += n.selfMs;
      s.callCount += n.callCount;
      s.maxMs = Math.max(s.maxMs, n.totalMs);
      s.minMs = Math.min(s.minMs, n.totalMs);
      if (n.hasChildren) s.hasChildren = true;
    }
  }

  const result = Array.from(map.values());

  // Calculate percentage relative to root totalMs
  const rootTotal = result.find(n => n.depth === 0)?.totalMs || 1;
  for (const n of result) {
    n.percentage = (n.totalMs / rootTotal) * 100;
    n.avgMs = n.callCount > 0 ? n.totalMs / n.callCount : 0;
  }

  // Sort by tree order (depth first, then by totalMs descending within same depth)
  result.sort((a, b) => {
    // Compare by path segments to maintain tree structure
    const aParts = a.fullPath.split('.');
    const bParts = b.fullPath.split('.');
    const len = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
      if (aParts[i] !== bParts[i]) {
        // Find siblings at this level and sort by totalMs
        return b.totalMs - a.totalMs;
      }
    }
    return a.depth - b.depth;
  });

  return result;
}

function buildSession(frames: FrameSnapshot[], startedAt: string, endedAt: string): RecordingSession {
  let fpsSum = 0, framemsSum = 0;
  const frameMsList: number[] = [];
  for (const f of frames) {
    fpsSum += f.fps;
    framemsSum += f.frameDeltaMs;
    frameMsList.push(f.frameDeltaMs);
  }
  frameMsList.sort((a, b) => a - b);
  const p99 = frameMsList.length > 0
    ? frameMsList[Math.floor(frameMsList.length * 0.99)] ?? frameMsList[frameMsList.length - 1]
    : 0;

  return {
    version: 2,
    startedAt,
    endedAt,
    totalFrames: frames.length,
    avgFps: frames.length > 0 ? fpsSum / frames.length : 0,
    avgFrameMs: frames.length > 0 ? framemsSum / frames.length : 0,
    p99FrameMs: p99,
    frames,
    summary: buildSummary(frames),
  };
}

// ---------------------------------------------------------------------------
// Compact JSON Export / Import
// ---------------------------------------------------------------------------
// Short keys: n=name, p=fullPath, d=depth, t=totalMs, s=selfMs,
//   pc=percentage, c=callCount, a=avgMs, x=maxMs, h=hasChildren
// Frame: fn=frameNumber, ts=timestamp, f=fps, fd=frameDeltaMs,
//   w=workMs, cu=cpuUtilization, m=memory, tr=tree
// Session: v=version, sa=startedAt, ea=endedAt, tf=totalFrames,
//   af=avgFps, am=avgFrameMs, p9=p99FrameMs, fr=frames, sm=summary

interface CompactNode {
  n: string; p: string; d: number; t: number; s: number;
  pc: number; c: number; a: number; x: number; h: number;
}

interface CompactFrame {
  fn: number; ts: number; f: number; fd: number;
  w: number; cu: number;
  m: [number, number, number] | null;
  tr: CompactNode[];
  gc: number; // 0 = no, 1 = suspected
  gm: number; // gcEstimatedMs
}

interface CompactSession {
  v: number; sa: string; ea: string; tf: number;
  af: number; am: number; p9: number;
  fr: CompactFrame[];
  sm: CompactNode[];
}

function packNode(n: FlatNode | SummaryNode): CompactNode {
  return {
    n: n.name, p: n.fullPath, d: n.depth,
    t: +n.totalMs.toFixed(3), s: +n.selfMs.toFixed(3),
    pc: +n.percentage.toFixed(1), c: n.callCount,
    a: +n.avgMs.toFixed(3), x: +n.maxMs.toFixed(3),
    h: n.hasChildren ? 1 : 0,
  };
}

function unpackNode(c: CompactNode, idx: number): FlatNode {
  return {
    index: idx, name: c.n, fullPath: c.p, depth: c.d,
    totalMs: c.t, selfMs: c.s, percentage: c.pc,
    callCount: c.c, avgMs: c.a, maxMs: c.x,
    hasChildren: c.h === 1,
  };
}

function unpackSummaryNode(c: CompactNode): SummaryNode {
  return {
    name: c.n, fullPath: c.p, depth: c.d,
    totalMs: c.t, selfMs: c.s, percentage: c.pc,
    callCount: c.c, avgMs: c.a, maxMs: c.x,
    minMs: 0, hasChildren: c.h === 1,
  };
}

function packSession(session: RecordingSession): CompactSession {
  return {
    v: session.version,
    sa: session.startedAt,
    ea: session.endedAt,
    tf: session.totalFrames,
    af: +session.avgFps.toFixed(1),
    am: +session.avgFrameMs.toFixed(2),
    p9: +session.p99FrameMs.toFixed(2),
    fr: session.frames.map(f => ({
      fn: f.frameNumber,
      ts: +f.timestamp.toFixed(1),
      f: f.fps,
      fd: +f.frameDeltaMs.toFixed(3),
      w: +f.workMs.toFixed(3),
      cu: +f.cpuUtilization.toFixed(1),
      m: f.memory ? [f.memory.heapUsed, f.memory.heapTotal, f.memory.heapLimit] : null,
      tr: f.tree.map(packNode),
      gc: f.gcSuspected ? 1 : 0,
      gm: +f.gcEstimatedMs.toFixed(3),
    })),
    sm: session.summary.map(packNode),
  };
}

function unpackSession(c: CompactSession): RecordingSession {
  return {
    version: c.v,
    startedAt: c.sa,
    endedAt: c.ea,
    totalFrames: c.tf,
    avgFps: c.af,
    avgFrameMs: c.am,
    p99FrameMs: c.p9,
    frames: c.fr.map(f => ({
      frameNumber: f.fn,
      timestamp: f.ts,
      fps: f.f,
      frameDeltaMs: f.fd,
      workMs: f.w,
      cpuUtilization: f.cu,
      memory: f.m ? { heapUsed: f.m[0], heapTotal: f.m[1], heapLimit: f.m[2] } : null,
      tree: f.tr.map(unpackNode),
      gcSuspected: f.gc === 1,
      gcEstimatedMs: f.gm || 0,
    })),
    summary: c.sm ? c.sm.map(unpackSummaryNode) : [],
  };
}

export function exportRecording(session: RecordingSession): string {
  return JSON.stringify(packSession(session));
}

export function importRecording(json: string): RecordingSession {
  const raw = JSON.parse(json);
  // Support both compact (v2 with short keys) and legacy (v1 with full keys)
  if (raw.fr && Array.isArray(raw.fr)) {
    return unpackSession(raw as CompactSession);
  }
  if (raw.version && Array.isArray(raw.frames)) {
    // Legacy v1 format — add summary and gc fields if missing
    const legacy = raw as RecordingSession;
    if (!legacy.summary) legacy.summary = buildSummary(legacy.frames);
    for (const f of legacy.frames) {
      if (f.gcSuspected === undefined) f.gcSuspected = false;
      if (f.gcEstimatedMs === undefined) f.gcEstimatedMs = 0;
    }
    return legacy;
  }
  throw new Error('Invalid profiler recording format');
}

function downloadJson(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function openFileDialog(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { reject(new Error('No file selected')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}

// ---------------------------------------------------------------------------
// overlay with tabs: Real-time | Snapshot
// ---------------------------------------------------------------------------

let overlayEl: HTMLDivElement | null = null;
let overlayVisible = false;
let lastOverlayUpdate = 0;
const collapsed = new Set<string>();
const snapshotCollapsed = new Set<string>();
const summaryCollapsed = new Set<string>();

type OverlayTab = 'realtime' | 'snapshot';
let activeTab: OverlayTab = 'realtime';

type SnapshotView = 'frames' | 'summary';
let snapshotView: SnapshotView = 'frames';

let loadedSession: RecordingSession | null = null;
let snapshotFrameIdx = 0;

const CL = {
  bg: 'rgba(12,12,14,0.92)',
  hdrBg: 'rgba(255,255,255,0.04)',
  txt: '#c8c8c8', dim: '#606060', bright: '#e8e8e8',
  grn: '#4ec970', yel: '#e8b930', red: '#e85454',
  blue: '#5b9bf2',
  barBg: 'rgba(255,255,255,0.06)',
  hover: 'rgba(255,255,255,0.04)',
  brd: 'rgba(255,255,255,0.06)',
  recRed: '#ff4455',
  accent: '#5b9bf2',
};

function pctColor(p: number): string {
  return p >= 40 ? CL.red : p >= 20 ? CL.yel : CL.grn;
}

function fmtMs(ms: number): string {
  return ms >= 10 ? ms.toFixed(1) : ms >= 1 ? ms.toFixed(2) : ms.toFixed(3);
}

export interface OverlayConfig {
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  margin?: number;
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: string;
  fontSize?: number;
  opacity?: number;
  zIndex?: number;
  startVisible?: boolean;
  toggleKey?: string;
  container?: HTMLElement;
}

const defaultConfig: Required<Omit<OverlayConfig, 'container'>> = {
  position: 'top-left',
  margin: 12,
  minWidth: 420,
  maxWidth: 520,
  maxHeight: '85vh',
  fontSize: 11,
  opacity: 0.92,
  zIndex: 99999,
  startVisible: false,
  toggleKey: 'F3',
};

let overlayConfig = { ...defaultConfig };

function positionCSS(pos: string, margin: number): string {
  switch (pos) {
    case 'top-right':    return `top:${margin}px;right:${margin}px;`;
    case 'bottom-left':  return `bottom:${margin}px;left:${margin}px;`;
    case 'bottom-right': return `bottom:${margin}px;right:${margin}px;`;
    default:             return `top:${margin}px;left:${margin}px;`;
  }
}

export function toggleOverlay(): void {
  overlayVisible = !overlayVisible;
  if (overlayEl) overlayEl.style.display = overlayVisible ? 'block' : 'none';
}

export function createOverlay(config?: OverlayConfig): HTMLDivElement {
  if (overlayEl) return overlayEl;

  if (config) {
    const { container: _, ...rest } = config;
    Object.assign(overlayConfig, rest);
  }
  const c = overlayConfig;
  if (config?.startVisible) overlayVisible = true;

  overlayEl = document.createElement('div');
  overlayEl.id = 'engine-profiler';
  overlayEl.style.cssText = `
    position:fixed;${positionCSS(c.position, c.margin)}z-index:${c.zIndex};
    background:rgba(12,12,14,${c.opacity});color:${CL.txt};
    font-family:'JetBrains Mono','Fira Code','SF Mono',Consolas,monospace;
    font-size:${c.fontSize}px;line-height:1;
    border-radius:8px;overflow:hidden;
    min-width:${c.minWidth}px;max-width:${c.maxWidth}px;max-height:${c.maxHeight};
    box-shadow:0 8px 32px rgba(0,0,0,0.5);
    border:1px solid rgba(255,255,255,0.08);
    display:${overlayVisible ? 'block' : 'none'};
    user-select:none;
  `;

  overlayEl.innerHTML = `
    <div id="pf-tabs" style="display:flex;border-bottom:1px solid ${CL.brd};"></div>
    <div id="pf-content"></div>
  `;

  const s = document.createElement('style');
  s.textContent = `
    #engine-profiler ::-webkit-scrollbar{width:4px}
    #engine-profiler ::-webkit-scrollbar-track{background:transparent}
    #engine-profiler ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:2px}
    #engine-profiler .pf-r{display:flex;align-items:center;padding:3px 12px;cursor:pointer;transition:background 0.1s}
    #engine-profiler .pf-r:hover{background:${CL.hover}}
    #engine-profiler .pf-btn{
      padding:4px 10px;border-radius:4px;border:1px solid ${CL.brd};
      background:rgba(255,255,255,0.04);color:${CL.txt};cursor:pointer;
      font-family:inherit;font-size:10px;transition:background 0.15s;
    }
    #engine-profiler .pf-btn:hover{background:rgba(255,255,255,0.1)}
    #engine-profiler .pf-btn-rec{border-color:${CL.recRed};color:${CL.recRed}}
    #engine-profiler .pf-btn-rec:hover{background:rgba(255,68,85,0.15)}
    #engine-profiler .pf-btn-active{background:${CL.recRed};color:#fff;border-color:${CL.recRed}}
    #engine-profiler .pf-btn-active:hover{background:#e03344}
    #engine-profiler .pf-tab{
      flex:1;padding:7px 0;text-align:center;cursor:pointer;
      color:${CL.dim};border-bottom:2px solid transparent;transition:all 0.15s;
      font-family:inherit;font-size:11px;background:none;border-top:none;border-left:none;border-right:none;
    }
    #engine-profiler .pf-tab:hover{color:${CL.txt}}
    #engine-profiler .pf-tab-active{color:${CL.bright};border-bottom-color:${CL.accent}}
    #engine-profiler .pf-vtab{
      padding:3px 10px;border-radius:3px;cursor:pointer;
      color:${CL.dim};font-family:inherit;font-size:10px;
      background:none;border:1px solid transparent;transition:all 0.15s;
    }
    #engine-profiler .pf-vtab:hover{color:${CL.txt}}
    #engine-profiler .pf-vtab-active{color:${CL.bright};background:rgba(255,255,255,0.06);border-color:${CL.brd}}
    @keyframes pf-blink{0%,100%{opacity:1}50%{opacity:0.3}}
  `;
  overlayEl.appendChild(s);

  (config?.container ?? document.body).appendChild(overlayEl);
  renderTabs();
  renderContent();
  return overlayEl;
}

// ---------------------------------------------------------------------------
// Tab rendering
// ---------------------------------------------------------------------------

function renderTabs(): void {
  if (!overlayEl) return;
  const tabsEl = overlayEl.querySelector('#pf-tabs');
  if (!tabsEl) return;

  const recDot = recording
    ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${CL.recRed};margin-right:4px;animation:pf-blink 1s infinite;"></span>`
    : '';

  tabsEl.innerHTML = `
    <button class="pf-tab ${activeTab === 'realtime' ? 'pf-tab-active' : ''}"
            onclick="window.__pf_setTab('realtime')">
      ${recDot}Real-time
    </button>
    <button class="pf-tab ${activeTab === 'snapshot' ? 'pf-tab-active' : ''}"
            onclick="window.__pf_setTab('snapshot')">
      Snapshot${loadedSession ? ' \u2713' : ''}
    </button>
  `;
}

function renderContent(): void {
  if (!overlayEl) return;
  const contentEl = overlayEl.querySelector('#pf-content');
  if (!contentEl) return;

  if (activeTab === 'realtime') {
    contentEl.innerHTML = `
      <div id="pf-hdr" style="padding:8px 12px;background:${CL.hdrBg};border-bottom:1px solid ${CL.brd};"></div>
      <div id="pf-spk" style="padding:4px 12px 6px;border-bottom:1px solid ${CL.brd};"></div>
      <div id="pf-tree" style="padding:4px 0;max-height:60vh;overflow-y:auto;"></div>
    `;
  } else {
    contentEl.innerHTML = htmlSnapshotPanel();
  }
}

// ---------------------------------------------------------------------------
// Real-time tab
// ---------------------------------------------------------------------------

function htmlHeader(): string {
  const fps = getFps();
  const util = getCpuUtilization();
  const mem = getMemoryUsage();
  const fc = fps >= 120 ? CL.grn : fps >= 60 ? CL.yel : CL.red;
  const uc = util < 50 ? CL.grn : util < 80 ? CL.yel : CL.red;

  let h = `<div style="display:flex;align-items:center;gap:14px;">`;
  h += `<span style="font-size:16px;font-weight:700;color:${fc};">${fps}<span style="font-size:10px;font-weight:400;color:${CL.dim};margin-left:2px;">fps</span></span>`;
  h += `<span style="color:${CL.dim};">${wallClockDeltaMs.toFixed(1)}ms/f</span>`;
  h += `<span style="color:${CL.dim};">work <span style="color:${CL.txt};">${fmtMs(lastWorkMs)}ms</span></span>`;
  h += `<span style="color:${uc};">Thread ${util.toFixed(0)}%</span>`;
  if (mem) h += `<span style="color:${CL.dim};">${(mem.heapUsed/1048576).toFixed(0)}MB</span>`;
  if (gcSuspected) {
    h += `<span style="color:#c678dd;font-weight:700;margin-left:4px;">GC ~${fmtMs(gcEstimatedMs)}ms</span>`;
  }
  if (gcCount > 0) {
    h += `<span style="color:${CL.dim};margin-left:auto;" title="Total GC events detected">GC:${gcCount}</span>`;
  }
  h += `<span style="color:${CL.dim};${gcCount === 0 ? 'margin-left:auto;' : ''}">P99 ${getP99FrameMs().toFixed(1)}ms</span>`;
  h += `</div>`;
  return h;
}

function htmlSpark(): string {
  const hist = getFrameHistory(60);
  let peak = 0;
  for (let i = 0; i < hist.length; i++) if (hist[i] > peak) peak = hist[i];
  if (peak < 4.2) peak = 4.2;

  const count = 60;
  const startIdx = Math.max(0, frameHistoryCursor - count);

  const W = 396, H = 24, bw = Math.floor(W / hist.length) - 1;
  let svg = `<svg width="${W}" height="${H}" style="display:block;">`;
  for (let i = 0; i < hist.length; i++) {
    const v = hist[i];
    const bh = Math.max(1, Math.min(1, v / peak) * H);
    const ringIdx = (startIdx + i) % HISTORY_FRAMES;
    const isGc = gcFrameFlags[ringIdx] === 1;
    const c = isGc ? '#c678dd' : (v > 16.6 ? CL.red : v > 8.3 ? CL.yel : CL.grn);
    svg += `<rect x="${i*(bw+1)}" y="${H-bh}" width="${bw}" height="${bh}" rx="1" fill="${c}" opacity="${isGc ? 1 : 0.7}"/>`;
    if (isGc) {
      svg += `<circle cx="${i*(bw+1)+bw/2}" cy="2" r="2" fill="#c678dd"/>`;
    }
  }
  const tY = H - Math.min(1, 16.6 / peak) * H;
  svg += `<line x1="0" y1="${tY}" x2="${W}" y2="${tY}" stroke="${CL.dim}" stroke-width="0.5" stroke-dasharray="3 3"/>`;
  svg += `</svg>`;
  return svg;
}

function htmlRow(n: FlatNode | SummaryNode, collapsedSet: Set<string>, toggleFn: string): string {
  const isCollapsed = collapsedSet.has(n.fullPath);
  const indent = n.depth * 16;
  const col = pctColor(n.percentage);
  const barW = Math.min(80, Math.max(2, n.percentage * 0.8));

  const arrow = n.hasChildren
    ? `<span style="display:inline-flex;width:14px;justify-content:center;color:${CL.dim};font-size:8px;transition:transform 0.15s;transform:rotate(${isCollapsed?'0':'90'}deg);">\u25B6</span>`
    : `<span style="display:inline-block;width:14px;text-align:center;color:${CL.dim};font-size:5px;">\u25CF</span>`;

  return `<div class="pf-r" onclick="window.${toggleFn}('${n.fullPath}')" style="padding-left:${12+indent}px;">
    ${arrow}
    <span style="flex:1;color:${CL.bright};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 8px 0 2px;">${n.name}</span>
    <span style="min-width:52px;text-align:right;color:${col};font-variant-numeric:tabular-nums;">${fmtMs(n.totalMs)}ms</span>
    <span style="min-width:48px;text-align:right;color:${CL.dim};font-variant-numeric:tabular-nums;font-size:10px;margin:0 4px;">self ${fmtMs(n.selfMs)}</span>
    <span style="min-width:28px;text-align:right;color:${CL.dim};font-variant-numeric:tabular-nums;margin-right:6px;">${n.percentage.toFixed(0)}%</span>
    <div style="width:80px;height:3px;border-radius:1.5px;background:${CL.barBg};flex:none;">
      <div style="height:100%;border-radius:1.5px;width:${barW}px;background:${col};transition:width 0.15s;"></div>
    </div>
  </div>`;
}

function htmlTreeFromNodes(tree: (FlatNode | SummaryNode)[], collapsedSet: Set<string>, toggleFn: string): string {
  if (tree.length === 0) return `<div style="padding:12px;color:${CL.dim};">No data</div>`;

  let html = '';
  let skipBelow = -1;

  for (const node of tree) {
    if (skipBelow >= 0) {
      if (node.depth > skipBelow) continue;
      else skipBelow = -1;
    }
    html += htmlRow(node, collapsedSet, toggleFn);
    if (collapsedSet.has(node.fullPath) && node.hasChildren) {
      skipBelow = node.depth;
    }
  }
  return html;
}

function htmlTree(): string {
  return htmlTreeFromNodes(getCallTree(), collapsed, '__pf_toggle');
}

// ---------------------------------------------------------------------------
// Snapshot tab HTML — stable DOM structure, targeted updates
// ---------------------------------------------------------------------------

function htmlSnapshotPanel(): string {
  let html = '';

  // Controls bar
  html += `<div style="padding:8px 12px;background:${CL.hdrBg};border-bottom:1px solid ${CL.brd};display:flex;align-items:center;gap:8px;">`;

  if (recording) {
    html += `<button class="pf-btn pf-btn-active" onclick="window.__pf_stopRec()">
      \u25A0 Stop (<span id="pf-rec-count">${recordedFrames.length}</span> frames)
    </button>`;
  } else {
    html += `<button class="pf-btn pf-btn-rec" onclick="window.__pf_startRec()">
      \u25CF Record
    </button>`;
  }

  html += `<span style="flex:1;"></span>`;
  html += `<button class="pf-btn" onclick="window.__pf_import()">Import</button>`;

  if (loadedSession) {
    html += `<button class="pf-btn" onclick="window.__pf_export()">Export</button>`;
  }

  html += `</div>`;

  if (loadedSession) {
    const s = loadedSession;

    // Session summary bar
    html += `<div style="padding:6px 12px;border-bottom:1px solid ${CL.brd};display:flex;align-items:center;gap:14px;">`;
    html += `<span style="color:${CL.dim};">${s.totalFrames} frames</span>`;
    html += `<span style="color:${CL.dim};">avg ${s.avgFps.toFixed(0)} fps</span>`;
    html += `<span style="color:${CL.dim};">${s.avgFrameMs.toFixed(1)}ms/f</span>`;
    html += `<span style="color:${CL.dim};">P99 ${s.p99FrameMs.toFixed(1)}ms</span>`;
    html += `</div>`;

    // Sub-tabs: Frames | Summary
    html += `<div style="padding:5px 12px;border-bottom:1px solid ${CL.brd};display:flex;gap:4px;">`;
    html += `<button class="pf-vtab ${snapshotView === 'frames' ? 'pf-vtab-active' : ''}" onclick="window.__pf_setView('frames')">Frames</button>`;
    html += `<button class="pf-vtab ${snapshotView === 'summary' ? 'pf-vtab-active' : ''}" onclick="window.__pf_setView('summary')">Summary</button>`;
    html += `</div>`;

    if (snapshotView === 'frames') {
      html += htmlSnapshotFrameView(s);
    } else {
      html += htmlSnapshotSummaryView(s);
    }

  } else if (!recording) {
    html += `<div style="padding:24px 12px;text-align:center;color:${CL.dim};">`;
    html += `Press <span style="color:${CL.bright};">Record</span> to capture frames<br>`;
    html += `or <span style="color:${CL.bright};">Import</span> a saved session`;
    html += `</div>`;
  }

  return html;
}

function htmlSnapshotFrameView(s: RecordingSession): string {
  let html = '';
  const frame = s.frames[snapshotFrameIdx];

  // Navigation — slider has id so we can keep it alive
  html += `<div id="pf-snap-nav" style="padding:6px 12px;border-bottom:1px solid ${CL.brd};display:flex;align-items:center;gap:8px;">`;
  html += `<button class="pf-btn" onclick="window.__pf_prevFrame()" ${snapshotFrameIdx <= 0 ? 'disabled style="opacity:0.3;pointer-events:none;"' : ''}>\u25C0</button>`;
  html += `<span id="pf-frame-label" style="color:${CL.bright};min-width:80px;text-align:center;">Frame ${snapshotFrameIdx + 1} / ${s.totalFrames}</span>`;
  html += `<button class="pf-btn" onclick="window.__pf_nextFrame()" ${snapshotFrameIdx >= s.totalFrames - 1 ? 'disabled style="opacity:0.3;pointer-events:none;"' : ''}>\u25B6</button>`;
  html += `<input id="pf-slider" type="range" min="0" max="${s.totalFrames - 1}" value="${snapshotFrameIdx}"
    oninput="window.__pf_seekFrame(+this.value)"
    style="flex:1;height:4px;accent-color:${CL.accent};cursor:pointer;" />`;
  html += `</div>`;

  // Sparkline
  html += `<div id="pf-snap-spark" style="padding:4px 12px 6px;border-bottom:1px solid ${CL.brd};">`;
  html += htmlSnapshotSpark(s, snapshotFrameIdx);
  html += `</div>`;

  // Frame detail
  html += `<div id="pf-snap-detail">`;
  if (frame) {
    html += htmlFrameDetail(frame);
  }
  html += `</div>`;

  return html;
}

function htmlFrameDetail(frame: FrameSnapshot): string {
  let html = '';
  const fc = frame.fps >= 120 ? CL.grn : frame.fps >= 60 ? CL.yel : CL.red;
  const uc = frame.cpuUtilization < 50 ? CL.grn : frame.cpuUtilization < 80 ? CL.yel : CL.red;

  html += `<div style="padding:6px 12px;border-bottom:1px solid ${CL.brd};display:flex;align-items:center;gap:14px;">`;
  html += `<span style="font-size:14px;font-weight:700;color:${fc};">${frame.fps}<span style="font-size:10px;font-weight:400;color:${CL.dim};margin-left:2px;">fps</span></span>`;
  html += `<span style="color:${CL.dim};">${frame.frameDeltaMs.toFixed(1)}ms/f</span>`;
  html += `<span style="color:${CL.dim};">work <span style="color:${CL.txt};">${fmtMs(frame.workMs)}ms</span></span>`;
  html += `<span style="color:${uc};">Thread ${frame.cpuUtilization.toFixed(0)}%</span>`;
  if (frame.memory) html += `<span style="color:${CL.dim};">${(frame.memory.heapUsed/1048576).toFixed(0)}MB</span>`;
  if (frame.gcSuspected) {
    html += `<span style="color:#c678dd;font-weight:700;">GC ~${fmtMs(frame.gcEstimatedMs)}ms</span>`;
  }
  html += `</div>`;

  html += `<div style="padding:4px 0;max-height:50vh;overflow-y:auto;">`;
  html += htmlTreeFromNodes(frame.tree, snapshotCollapsed, '__pf_stoggle');
  html += `</div>`;

  return html;
}

function htmlSnapshotSummaryView(s: RecordingSession): string {
  let html = '';

  // Total time header
  const rootNode = s.summary.find(n => n.depth === 0);
  const totalTime = rootNode ? rootNode.totalMs : 0;

  html += `<div style="padding:6px 12px;border-bottom:1px solid ${CL.brd};display:flex;align-items:center;gap:14px;">`;
  html += `<span style="color:${CL.bright};">Total: ${fmtMs(totalTime)}ms</span>`;
  html += `<span style="color:${CL.dim};">across ${s.totalFrames} frames</span>`;
  html += `<span style="color:${CL.dim};">avg/frame ${fmtMs(totalTime / Math.max(1, s.totalFrames))}ms</span>`;
  html += `</div>`;

  html += `<div style="padding:4px 0;max-height:55vh;overflow-y:auto;">`;
  html += htmlTreeFromNodes(s.summary, summaryCollapsed, '__pf_sumtoggle');
  html += `</div>`;

  return html;
}

function htmlSnapshotSpark(session: RecordingSession, currentIdx: number): string {
  const frames = session.frames;
  const count = frames.length;
  if (count === 0) return '';

  let peak = 0;
  for (const f of frames) if (f.frameDeltaMs > peak) peak = f.frameDeltaMs;
  if (peak < 4.2) peak = 4.2;

  const W = 396, H = 24;
  const bw = Math.max(1, Math.min(6, Math.floor(W / count) - 1));
  const step = count > W ? count / W : 1;

  let svg = `<svg width="${W}" height="${H}" style="display:block;cursor:pointer;" onclick="window.__pf_sparkClick(event,${W},${count})">`;

  for (let i = 0; i < count; i += step) {
    const fi = Math.floor(i);
    const v = frames[fi].frameDeltaMs;
    const bh = Math.max(1, Math.min(1, v / peak) * H);
    const isCurrent = fi === currentIdx;
    const isGc = frames[fi].gcSuspected;
    const c = isCurrent ? CL.accent : isGc ? '#c678dd' : (v > 16.6 ? CL.red : v > 8.3 ? CL.yel : CL.grn);
    const x = (fi / count) * W;
    svg += `<rect x="${x}" y="${H-bh}" width="${Math.max(bw, 2)}" height="${bh}" rx="1" fill="${c}" opacity="${isCurrent ? 1 : (isGc ? 1 : 0.7)}"/>`;
    if (isGc) {
      svg += `<circle cx="${x + Math.max(bw, 2)/2}" cy="2" r="2" fill="#c678dd"/>`;
    }
  }

  const tY = H - Math.min(1, 16.6 / peak) * H;
  svg += `<line x1="0" y1="${tY}" x2="${W}" y2="${tY}" stroke="${CL.dim}" stroke-width="0.5" stroke-dasharray="3 3"/>`;
  svg += `</svg>`;
  return svg;
}

// ---------------------------------------------------------------------------
// Targeted DOM updates for snapshot (no full rerender)
// ---------------------------------------------------------------------------

function updateSnapshotFrame(): void {
  if (!overlayEl || !loadedSession) return;

  // Update label
  const label = overlayEl.querySelector('#pf-frame-label');
  if (label) label.textContent = `Frame ${snapshotFrameIdx + 1} / ${loadedSession.totalFrames}`;

  // Update slider value without destroying it
  const slider = overlayEl.querySelector('#pf-slider') as HTMLInputElement | null;
  if (slider && document.activeElement !== slider) {
    slider.value = String(snapshotFrameIdx);
  }

  // Update sparkline
  const sparkEl = overlayEl.querySelector('#pf-snap-spark');
  if (sparkEl) sparkEl.innerHTML = htmlSnapshotSpark(loadedSession, snapshotFrameIdx);

  // Update frame detail
  const detailEl = overlayEl.querySelector('#pf-snap-detail');
  if (detailEl) {
    const frame = loadedSession.frames[snapshotFrameIdx];
    detailEl.innerHTML = frame ? htmlFrameDetail(frame) : '';
  }
}

// ---------------------------------------------------------------------------
// Window callbacks
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  (window as any).__pf_toggle = (path: string) => {
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
    if (overlayEl && overlayVisible && activeTab === 'realtime') {
      const el = overlayEl.querySelector('#pf-tree');
      if (el) el.innerHTML = htmlTree();
    }
  };

  (window as any).__pf_stoggle = (path: string) => {
    if (snapshotCollapsed.has(path)) snapshotCollapsed.delete(path);
    else snapshotCollapsed.add(path);
    // Only update the detail section, not the whole panel
    if (overlayEl && loadedSession) {
      const detailEl = overlayEl.querySelector('#pf-snap-detail');
      const frame = loadedSession.frames[snapshotFrameIdx];
      if (detailEl && frame) detailEl.innerHTML = htmlFrameDetail(frame);
    }
  };

  (window as any).__pf_sumtoggle = (path: string) => {
    if (summaryCollapsed.has(path)) summaryCollapsed.delete(path);
    else summaryCollapsed.add(path);
    if (overlayEl && activeTab === 'snapshot' && snapshotView === 'summary') {
      renderContent();
    }
  };

  (window as any).__pf_setTab = (tab: OverlayTab) => {
    activeTab = tab;
    renderTabs();
    renderContent();
    if (tab === 'realtime') forceUpdateRealtime();
  };

  (window as any).__pf_setView = (view: SnapshotView) => {
    snapshotView = view;
    renderContent();
  };

  (window as any).__pf_startRec = () => {
    startRecording();
    renderTabs();
    renderContent();
  };

  (window as any).__pf_stopRec = () => {
    // Set flag immediately so endFrame stops pushing snapshots
    recording = false;
    // Build session from already-captured frames (synchronous but no new frames arrive)
    loadedSession = buildSession(recordedFrames, recordingStartTime, new Date().toISOString());
    snapshotFrameIdx = 0;
    snapshotView = 'frames';
    renderTabs();
    renderContent();
  };

  (window as any).__pf_export = () => {
    if (!loadedSession) return;
    const json = exportRecording(loadedSession);
    const ts = loadedSession.startedAt.replace(/[:.]/g, '-');
    downloadJson(json, `profiler-${ts}.json`);
  };

  (window as any).__pf_import = async () => {
    try {
      const json = await openFileDialog();
      loadedSession = importRecording(json);
      snapshotFrameIdx = 0;
      snapshotView = 'frames';
      renderContent();
    } catch (_) { /* user cancelled or bad file */ }
  };

  (window as any).__pf_prevFrame = () => {
    if (snapshotFrameIdx > 0) { snapshotFrameIdx--; updateSnapshotFrame(); }
  };

  (window as any).__pf_nextFrame = () => {
    if (loadedSession && snapshotFrameIdx < loadedSession.totalFrames - 1) {
      snapshotFrameIdx++;
      updateSnapshotFrame();
    }
  };

  (window as any).__pf_seekFrame = (idx: number) => {
    if (!loadedSession) return;
    snapshotFrameIdx = Math.max(0, Math.min(idx, loadedSession.totalFrames - 1));
    updateSnapshotFrame();
  };

  (window as any).__pf_sparkClick = (event: MouseEvent, W: number, count: number) => {
    const idx = Math.floor(event.offsetX / W * count);
    (window as any).__pf_seekFrame(idx);
  };
}

// ---------------------------------------------------------------------------
// Overlay update
// ---------------------------------------------------------------------------

function forceUpdateRealtime(): void {
  if (!overlayEl) return;
  const hdr = overlayEl.querySelector('#pf-hdr');
  const spk = overlayEl.querySelector('#pf-spk');
  const tre = overlayEl.querySelector('#pf-tree');
  if (hdr) hdr.innerHTML = htmlHeader();
  if (spk) spk.innerHTML = htmlSpark();
  if (tre) tre.innerHTML = htmlTree();
}

export function updateOverlay(): void {
  if (!overlayEl || !overlayVisible) return;
  const now = performance.now();
  if (now - lastOverlayUpdate < OVERLAY_UPDATE_INTERVAL) return;
  lastOverlayUpdate = now;

  if (recording) renderTabs();

  if (activeTab === 'realtime') {
    forceUpdateRealtime();
  } else if (recording) {
    // Only update the frame counter, not the whole panel
    const countEl = overlayEl.querySelector('#pf-rec-count');
    if (countEl) countEl.textContent = String(recordedFrames.length);
  }
}

if (PROFILING_ENABLED && typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === overlayConfig.toggleKey) { e.preventDefault(); if (!overlayEl) createOverlay(); toggleOverlay(); }
  });
}

export const Profiler = {
  beginScope, endScope, profile, profileAsync,
  beginFrame, endFrame,
  getCallTree, getHotScopes,
  getFps, getFrameDeltaMs, getWorkMs, getCpuUtilization,
  isGcSuspected, getGcEstimatedMs, getGcCount,
  getFrameCount, getAverageFrameMs, getP99FrameMs, getFrameHistory,
  getScopeMs, getScopeAvgMs,
  getMemoryUsage, getTextReport,
  createOverlay, updateOverlay, toggleOverlay,
  startRecording, stopRecording, isRecording, getRecordedFrameCount,
  exportRecording, importRecording,
  ENABLED: PROFILING_ENABLED,
} as const;

export default Profiler;
