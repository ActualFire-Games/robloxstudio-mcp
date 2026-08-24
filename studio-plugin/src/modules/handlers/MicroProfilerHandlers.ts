import { HttpService, LogService, RunService } from "@rbxts/services";
import Utils from "../Utils";

const { getInstanceByPath } = Utils;

interface LibMPControl {
	EnableProfiler(this: LibMPControl, enable: boolean): boolean;
	EnableCapture(this: LibMPControl, enable: boolean): boolean;
	CaptureToBufferSync(this: LibMPControl): buffer;
	IsBackendAccessible(this: LibMPControl): boolean;
	IsBackendReady(this: LibMPControl): boolean;
	IsBackendVersionCompatible(this: LibMPControl): boolean;
}

interface LibMPLike {
	Control: LibMPControl;
	Session: {
		OpenFromBuffer(this: void, data: buffer): LibMPSession | undefined;
		// Opens a session over the profiler's live ring buffer. Verified to work inside the
		// plugin VM on runtime peers, and to stay valid across EnableCapture(false)/(true)
		// cycles, so one session can be opened once and reused for every armed capture.
		OpenFromLiveData(this: void): LibMPSession | undefined;
	};
	Versions?: Record<string, unknown>;
	GetMemUsed?: () => number;
}

interface LibMPSession {
	IsValid(this: LibMPSession): boolean;
	SyncWithDataSource(this: LibMPSession): boolean;
	GetDataFormatVersion(this: LibMPSession): number;
	GetObjSize(this: LibMPSession): number;
	FetchTimerIds(this: LibMPSession): number[];
	FetchThreadIds(this: LibMPSession): number[];
	FetchThreadDesc(this: LibMPSession, threadId: number): ThreadDesc | undefined;
	GetFrameIdMin(this: LibMPSession): number;
	GetFrameIdMax(this: LibMPSession): number;
	GetFrameDesc(this: LibMPSession, frameId: number): FrameDesc | undefined;
	FetchTimerDesc(this: LibMPSession, timerId: number): TimerDesc | undefined;
	FetchGroupDesc(this: LibMPSession, groupId: number): GroupDesc | undefined;
	FindGroupIds(this: LibMPSession, nameMask: string, caseSensitive?: boolean): number[];
	FindTimerIds(this: LibMPSession, nameMask: string, caseSensitive?: boolean): number[];
	CreateLogIterator(this: LibMPSession): LogIterator;
	Dispose(this: LibMPSession): void;
}

interface TimerDesc {
	TimerId?: number;
	TimerName?: string;
	GroupId?: number;
	IsUserTimer?: boolean;
}

interface GroupDesc {
	GroupId?: number;
	GroupName?: string;
	IsGpu?: boolean;
}

interface ThreadDesc {
	ThreadId?: number;
	ThreadName?: string;
	BufferSize?: number;
	IsGpu?: boolean;
}

interface FrameDesc {
	FrameId(this: FrameDesc): number;
	// Engine-wide frame counter. Session-local FrameIds shift as the ring evicts frames,
	// so the absolute id is what lets a trigger frame be found again in a later snapshot.
	FrameAbsoluteId(this: FrameDesc): number;
	TickStartCpu(this: FrameDesc): number;
	TickEndCpu(this: FrameDesc): number;
	IsIncomplete(this: FrameDesc): boolean;
	IsPaused(this: FrameDesc): boolean;
}

interface LogIterator {
	Configure(this: LogIterator, config: Record<string, unknown>): void;
	Step(this: LogIterator): boolean;
	GetState(this: LogIterator): LogIteratorState | undefined;
	RewindTo?(this: LogIterator, minFrameId: number, maxFrameId: number): void;
	Dispose(this: LogIterator): void;
}

interface LogIteratorState {
	FrameId(this: LogIteratorState): number;
	ThreadId(this: LogIteratorState): number;
	TimerId(this: LogIteratorState): number;
	Timestamp(this: LogIteratorState): number;
	IsEnter(this: LogIteratorState): boolean;
	IsExit(this: LogIteratorState): boolean;
}

interface StackEntry {
	timerId: number;
	timestampRaw: number;
	childRaw: number;
	frameId: number;
}

interface TimerInfo {
	timer_id: number;
	name: string;
	group_id?: number;
	group?: string;
	is_user_timer?: boolean;
}

interface TimerAggregate {
	timer_id: number;
	inclusive_raw: number;
	exclusive_raw: number;
	count: number;
	max_raw: number;
}

interface GroupAggregate {
	group: string;
	inclusive_raw: number;
	exclusive_raw: number;
	count: number;
}

interface EdgeAggregate {
	parent_timer_id: number;
	child_timer_id: number;
	inclusive_raw: number;
	count: number;
	max_raw: number;
}

// Every knob the analysis pass reads. Held in one object so a stored snapshot can be
// re-analyzed later (action="analyze") with completely different settings.
interface AnalysisSettings {
	maxTimers: number;
	maxGroups: number;
	maxTimersPerGroup: number;
	maxRelatedTimers: number;
	maxEvents: number;
	minTotalUs: number;
	focus: string;
	filter?: string;
	includeIdle: boolean;
	includeGpu: boolean;
	includeRawBuffer: boolean;
	includeComparisonIndex: boolean;
	targetRole: string;
	maxFrameBreakdowns: number;
}

// Which frames of the snapshot to analyze. "tail" is the classic behaviour (the last
// frame_window frames); "trigger" centres the window on the frame that fired a trigger.
interface WindowSpec {
	mode: string;
	frame_window?: number;
	trigger_frame_id?: number;
	trigger_frame_absolute_id?: number;
	frames_before?: number;
	post_trigger_frames?: number;
}

interface AnalysisContext {
	warmupFramesAbsorbed: number;
	durationMs?: number;
	backend: Record<string, unknown>;
}

interface FrameDescInfo {
	frame_id: number;
	frame_absolute_id: number;
	duration_raw: number;
	duration_us: number;
	duration_valid: boolean;
	incomplete: boolean;
	paused: boolean;
}

interface WalkedSegment {
	start: number;
	end: number;
	walked: boolean;
	last_frame_id?: number;
	limited: boolean;
}

interface NormalizedTrigger {
	kind: string;
	threshold_ms?: number;
	instance?: string;
	name?: string;
	value?: unknown;
	substring?: string;
}

interface TriggerNormalizeResult {
	trigger?: NormalizedTrigger;
	instance?: Instance;
	error?: Record<string, unknown>;
}

interface ObservedStats {
	frames_seen: number;
	max_frame_us: number;
	max_frame_id: number;
	max_frame_absolute_id: number;
	total_frame_us: number;
	watcher_total_us: number;
	watcher_samples: number;
}

interface PendingExternalTrigger {
	matched_message?: string;
	attribute_value?: unknown;
}

interface CaptureRecord {
	capture_id: string;
	kind: string;
	status: string;
	target: string;
	created_clock: number;
	finished_clock?: number;
	created_at_ms: number;
	snapshot?: buffer;
	snapshot_bytes?: number;
	trigger?: NormalizedTrigger;
	arm_timeout_ms: number;
	frames_before: number;
	post_trigger_frames: number;
	post_trigger_frames_remaining?: number;
	duration_ms?: number;
	frame_window?: number;
	trigger_info?: Record<string, unknown>;
	observed: ObservedStats;
	warmup_frames_absorbed: number;
	warming_up: boolean;
	error_message?: string;
	message?: string;
	connections: RBXScriptConnection[];
	cancel_requested: boolean;
	pending_external?: PendingExternalTrigger;
}

const DEFAULT_DURATION_MS = 1000;
const MIN_DURATION_MS = 100;
const MAX_DURATION_MS = 5000;
const DEFAULT_MAX_TIMERS = 20;
const DEFAULT_MAX_GROUPS = 20;
const DEFAULT_MAX_TIMERS_PER_GROUP = 5;
const DEFAULT_MAX_RELATED_TIMERS = 3;
const DEFAULT_MAX_EVENTS = 250000;
const MAX_EVENTS = 1000000;
const DEFAULT_FRAME_WINDOW = 240;
const DEFAULT_MAX_FRAME_BREAKDOWNS = 3;
const MAX_FRAME_BREAKDOWN_TIMERS = 12;
const DEFAULT_ARM_TIMEOUT_MS = 60000;
const MIN_ARM_TIMEOUT_MS = 1000;
const MAX_ARM_TIMEOUT_MS = 300000;
const DEFAULT_FRAMES_BEFORE = 8;
const DEFAULT_POST_TRIGGER_FRAMES = 30;
const MAX_TRIGGER_WINDOW_FRAMES = 240;
// The profiler ring holds exactly 256 frames, so a trigger window wider than that would
// ask for frames the snapshot cannot contain.
const RING_FRAME_LIMIT = 256;
const RETAIN_CAPTURE_SECONDS = 600;
const MAX_RETAINED_SNAPSHOTS = 3;
const VALID_ACTIONS = ["capture", "arm", "collect", "cancel", "analyze"];
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD_BYTE = string.byte("=")[0];

const B64: number[] = [];
for (let i = 0; i < 64; i++) {
	B64[i] = string.byte(BASE64_CHARS, i + 1)[0];
}

const FOCUS_GROUP_MASKS: Record<string, string[]> = {
	all: [],
	script: ["Script", "LuaBridge"],
	physics: ["Physics"],
	render: ["Render"],
	network: ["Network", "RbxTransport", "Replicator"],
	jobs: ["Jobs"],
};

let cachedLibMP: LibMPLike | undefined;

// The first capture after LibMP's profiler is enabled carries a one-time ~350ms
// engine stall ~12 frames into the capture (reproduced repeatedly). The stall frame
// carries a single log entry and reports IsPaused=false, so the data-quality
// heuristics never catch it. Absorbing this many extra frames before the real capture
// window opens pushes the stall frame out of the rolling buffer so it never skews stats.
const WARMUP_FRAMES = 24;
let captureWarmedUp = false;

// A capture holds the runtime peer's thread across its capture window AND the whole
// aggregation walk (which now yields cooperatively). Two overlapping captures would
// corrupt the shared warmup flag / LibMP session state and double the freeze, so
// re-entrant calls are rejected instead.
let captureInProgress = false;

// An analysis walk yields cooperatively too, so two overlapping walks would interleave
// and share nothing but trouble (and a walk during a live capture would steal frames
// from the peer being measured).
let analysisInProgress = false;

// One live-data session reused by every armed capture. It stays valid across
// EnableCapture(false)/(true) cycles, so reopening it per capture is pure waste.
let liveSession: LibMPSession | undefined;

const captures = new Map<string, CaptureRecord>();
let captureOrder: string[] = [];
let captureCounter = 0;

function normalizeDurationMs(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_DURATION_MS;
	return math.clamp(math.floor(value), MIN_DURATION_MS, MAX_DURATION_MS);
}

function normalizeMaxTimers(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_TIMERS;
	return math.clamp(math.floor(value), 1, 100);
}

function normalizeMaxGroups(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_GROUPS;
	return math.clamp(math.floor(value), 1, 100);
}

function normalizeMaxTimersPerGroup(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_TIMERS_PER_GROUP;
	return math.clamp(math.floor(value), 0, 20);
}

function normalizeMaxRelatedTimers(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_RELATED_TIMERS;
	return math.clamp(math.floor(value), 0, 10);
}

function normalizeMaxEvents(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_EVENTS;
	return math.clamp(math.floor(value), 10000, MAX_EVENTS);
}

function normalizeFrameWindow(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_FRAME_WINDOW;
	return math.clamp(math.floor(value), 1, 2000);
}

function normalizeMaxFrameBreakdowns(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_FRAME_BREAKDOWNS;
	return math.clamp(math.floor(value), 0, 10);
}

function normalizeArmTimeoutMs(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_ARM_TIMEOUT_MS;
	return math.clamp(math.floor(value), MIN_ARM_TIMEOUT_MS, MAX_ARM_TIMEOUT_MS);
}

function normalizeFramesBefore(value: unknown, fallback: number): number {
	if (!typeIs(value, "number")) return fallback;
	return math.clamp(math.floor(value), 0, 200);
}

function normalizePostTriggerFrames(value: unknown, fallback: number): number {
	if (!typeIs(value, "number")) return fallback;
	return math.clamp(math.floor(value), 0, 200);
}

function normalizeMinTotalUs(value: unknown): number {
	if (!typeIs(value, "number")) return 0;
	return math.max(0, value);
}

function normalizeFocus(value: unknown): string {
	if (!typeIs(value, "string") || FOCUS_GROUP_MASKS[value] === undefined) return "all";
	return value;
}

function stringContains(haystack: string, needle: string): boolean {
	return string.find(string.lower(haystack), string.lower(needle), 1, true)[0] !== undefined;
}

function rawToUs(raw: number): number {
	return math.floor(raw / 1000 + 0.5);
}

function round2(value: number): number {
	return math.floor(value * 100 + 0.5) / 100;
}

function perSecond(value: number, durationMs: number): number {
	return durationMs > 0 ? round2(value / (durationMs / 1000)) : value;
}

function percent(part: number, whole: number): number {
	return whole > 0 ? round2((part / whole) * 100) : 0;
}

function ratio(numerator: number, denominator: number): number | undefined {
	if (denominator <= 0) return undefined;
	return round2(numerator / denominator);
}

function percentile(sortedValues: number[], fraction: number): number {
	if (sortedValues.size() === 0) return 0;
	const index = math.clamp(math.ceil(sortedValues.size() * fraction), 1, sortedValues.size()) - 1;
	return sortedValues[index];
}

function copyRecord(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of pairs(row)) {
		out[key as string] = value;
	}
	return out;
}

function pickFields(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		const value = row[field];
		if (value !== undefined) out[field] = value;
	}
	return out;
}

function addFrameRaw(map: Map<number, number>, frameId: number, raw: number): void {
	if (frameId <= 0) return;
	map.set(frameId, (map.get(frameId) ?? 0) + raw);
}

function summarizeFrameImpact(frameRawById: Map<number, number> | undefined, analyzedFrames: number): Record<string, unknown> {
	if (frameRawById === undefined || frameRawById.size() === 0) {
		return {
			active_frame_count: 0,
			active_frame_pct: 0,
			inclusive_us_per_frame: 0,
			p95_active_frame_inclusive_us: 0,
			max_frame_inclusive_us: 0,
		};
	}

	const values: number[] = [];
	let totalUs = 0;
	let maxUs = 0;
	let maxFrameId = 0;
	for (const [frameId, raw] of frameRawById) {
		const us = rawToUs(raw);
		values.push(us);
		totalUs += us;
		if (us > maxUs) {
			maxUs = us;
			maxFrameId = frameId;
		}
	}
	values.sort((a, b) => a < b);

	return {
		active_frame_count: values.size(),
		active_frame_pct: percent(values.size(), analyzedFrames),
		inclusive_us_per_frame: analyzedFrames > 0 ? round2(totalUs / analyzedFrames) : totalUs,
		avg_active_frame_inclusive_us: values.size() > 0 ? round2(totalUs / values.size()) : 0,
		p95_active_frame_inclusive_us: percentile(values, 0.95),
		max_frame_inclusive_us: maxUs,
		max_frame_id: maxFrameId,
	};
}

function encodeBase64(buf: buffer): string {
	const len = buffer.len(buf);
	const fullTriples = math.floor(len / 3);
	const remaining = len - fullTriples * 3;
	const outLen = (fullTriples + (remaining > 0 ? 1 : 0)) * 4;
	const out = buffer.create(outLen);

	let si = 0;
	let di = 0;

	for (let t = 0; t < fullTriples; t++) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		const b2 = buffer.readu8(buf, si + 2);

		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.bor(bit32.lshift(bit32.band(b1, 15), 2), bit32.rshift(b2, 6))]);
		buffer.writeu8(out, di + 3, B64[bit32.band(b2, 63)]);

		si += 3;
		di += 4;
	}

	if (remaining === 2) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.lshift(bit32.band(b1, 15), 2)]);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	} else if (remaining === 1) {
		const b0 = buffer.readu8(buf, si);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.lshift(bit32.band(b0, 3), 4)]);
		buffer.writeu8(out, di + 2, PAD_BYTE);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	}

	return buffer.tostring(out);
}

function requireLibMP(): LibMPLike | Record<string, unknown> {
	if (cachedLibMP !== undefined) return cachedLibMP;
	const includeFolder = script.Parent!.Parent!.Parent!.FindFirstChild("include");
	const libModule = includeFolder && includeFolder.FindFirstChild("LibMP");
	if (!libModule || !libModule.IsA("ModuleScript")) {
		return {
			error: "libmp_missing",
			message: "The MCP plugin bundle does not contain include/LibMP.",
		};
	}
	const [ok, libOrErr] = pcall(() => require(libModule) as LibMPLike);
	if (!ok) {
		return {
			error: "libmp_require_failed",
			message: tostring(libOrErr),
		};
	}
	cachedLibMP = libOrErr as LibMPLike;
	return cachedLibMP;
}

function safeCall<T>(fn: () => T): LuaTuple<[boolean, T | string]> {
	const [ok, value] = pcall(fn);
	if (ok) return $tuple(true, value as T);
	return $tuple(false, tostring(value));
}

function isIdleTimer(info: TimerInfo): boolean {
	const name = string.lower(info.name);
	if (name === "sleep" || name === "idle") return true;
	if (string.find(name, "sleep", 1, true)[0] !== undefined) return true;
	return false;
}

function recommendedToolsForGroups(groups: Record<string, unknown>[], targetRole: string): Record<string, unknown>[] {
	const tools: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	for (const row of groups) {
		const group = row.group;
		if (!typeIs(group, "string") || seen.has(group)) continue;
		seen.add(group);
		if (group === "Script" || group === "LuaBridge") {
			tools.push({
				tool: "capture_script_profiler",
				arguments: { target: targetRole, duration_ms: 1000 },
				reason: "Script/LuaBridge timers are present.",
			});
		} else if (group === "Physics") {
			tools.push({ tool: "get_scene_analysis", reason: "Physics timers are present; inspect scene complexity." });
		} else if (group === "Render") {
			tools.push({ tool: "capture_screenshot", reason: "Render timers are present; inspect visible scene/UI state." });
		} else if (group === "Network" || group === "RbxTransport" || group === "Replicator") {
			tools.push({ tool: "get_runtime_logs", reason: "Network/replication timers are present; correlate with gameplay events." });
		} else if (group === "Jobs") {
			tools.push({ tool: "capture_micro_profiler", arguments: { target: targetRole, focus: "jobs" }, reason: "Jobs timers are present; narrow to job lanes if needed." });
		}
		if (tools.size() >= 3) break;
	}
	return tools;
}

// Copies one frame desc into a plain table. LibMP invalidates a Get* view as soon as the
// next Get*/Fetch* call runs on the same session, so every field is read immediately,
// before anything else touches the session.
function readFrameDesc(session: LibMPSession, frameId: number): FrameDescInfo | undefined {
	const [ok, descOrErr] = safeCall(() => session.GetFrameDesc(frameId));
	if (!ok || !descOrErr) return undefined;
	const desc = descOrErr as FrameDesc;
	const [readOk, infoOrErr] = safeCall(() => {
		const tickStart = desc.TickStartCpu();
		const tickEnd = desc.TickEndCpu();
		const durationRaw = tickEnd - tickStart;
		const info: FrameDescInfo = {
			frame_id: desc.FrameId(),
			frame_absolute_id: desc.FrameAbsoluteId(),
			duration_raw: durationRaw,
			duration_us: rawToUs(durationRaw),
			duration_valid: durationRaw > 0 && durationRaw <= 1000000000000,
			incomplete: desc.IsIncomplete(),
			paused: desc.IsPaused(),
		};
		return info;
	});
	if (!readOk || !typeIs(infoOrErr, "table")) return undefined;
	return infoOrErr as FrameDescInfo;
}

function collectFrameDescs(session: LibMPSession, startFrame: number, frameMax: number): Map<number, FrameDescInfo> {
	const descs = new Map<number, FrameDescInfo>();
	for (let frameId = startFrame; frameId <= frameMax; frameId++) {
		const info = readFrameDesc(session, frameId);
		if (info === undefined) continue;
		descs.set(frameId, info);
	}
	return descs;
}

function collectFrameSummary(frameDescs: Map<number, FrameDescInfo>, frameIds: number[], triggerFrameId: number | undefined): Record<string, unknown> {
	const frameRows: Record<string, unknown>[] = [];
	const durations: number[] = [];
	let incompleteFrames = 0;
	let pausedFrames = 0;

	for (const frameId of frameIds) {
		const desc = frameDescs.get(frameId);
		if (desc === undefined) continue;
		if (desc.incomplete) incompleteFrames += 1;
		if (desc.paused) {
			// Paused frames span the idle gap since the previous capture session; their
			// multi-second spans would wreck avg/p50/p95/max and dominate top_frames.
			// Count them for reporting, then skip them out of the statistics entirely.
			pausedFrames += 1;
			continue;
		}
		if (!desc.duration_valid) continue;
		const durationUs = desc.duration_us;
		durations.push(durationUs);
		const row: Record<string, unknown> = {
			frame_id: frameId,
			frame_absolute_id: desc.frame_absolute_id,
			duration_us: durationUs,
		};
		if (desc.incomplete) row.incomplete = true;
		if (triggerFrameId !== undefined && frameId === triggerFrameId) row.is_trigger_frame = true;
		frameRows.push(row);
	}

	durations.sort((a, b) => a < b);
	frameRows.sort((a, b) => (a.duration_us as number) > (b.duration_us as number));

	let totalUs = 0;
	for (const duration of durations) totalUs += duration;

	const topFrames: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(10, frameRows.size()); i++) {
		topFrames.push(frameRows[i]);
	}

	const count = durations.size();
	return {
		frames: count,
		total_duration_us: totalUs,
		avg_us: count > 0 ? round2(totalUs / count) : 0,
		p50_us: percentile(durations, 0.5),
		p95_us: percentile(durations, 0.95),
		max_us: count > 0 ? durations[count - 1] : 0,
		incomplete_frames: incompleteFrames,
		paused_frames: pausedFrames,
		top_frames: topFrames,
	};
}

// Decodes a snapshot buffer and produces the whole analysis payload. Split out of the
// blocking capture path so a stored snapshot can be re-analyzed later with different
// settings (action="analyze") and so triggered captures share exactly one aggregator.
function analyzeSnapshot(LibMP: LibMPLike, snapshot: buffer, settings: AnalysisSettings, windowSpec: WindowSpec, ctx: AnalysisContext): Record<string, unknown> {
	const maxTimers = settings.maxTimers;
	const maxGroups = settings.maxGroups;
	const maxTimersPerGroup = settings.maxTimersPerGroup;
	const maxRelatedTimers = settings.maxRelatedTimers;
	const maxEvents = settings.maxEvents;
	const minTotalUs = settings.minTotalUs;
	const focus = settings.focus;
	const filter = settings.filter;
	const includeIdle = settings.includeIdle;
	const includeGpu = settings.includeGpu;
	const includeRawBuffer = settings.includeRawBuffer;
	const includeComparisonIndex = settings.includeComparisonIndex;
	const targetRole = settings.targetRole;
	const maxFrameBreakdowns = settings.maxFrameBreakdowns;
	const backend = ctx.backend;
	const durationMs = ctx.durationMs;
	const warmupFramesAbsorbed = ctx.warmupFramesAbsorbed;
	// Only a blocking capture knows a wall-clock duration; triggered captures fall back
	// to the summed frame durations of the analyzed window.
	const fallbackDurationUs = (durationMs ?? 0) * 1000;

	const [sessionOk, sessionOrErr] = safeCall(() => LibMP.Session.OpenFromBuffer(snapshot));
	if (!sessionOk || !sessionOrErr) {
		return {
			error: "micro_profiler_decode_failed",
			message: tostring(sessionOrErr),
			buffer_bytes: buffer.len(snapshot),
			backend,
		};
	}
	const session = sessionOrErr as LibMPSession;
	if (!session.IsValid()) {
		session.Dispose();
		return {
			error: "micro_profiler_session_invalid",
			buffer_bytes: buffer.len(snapshot),
			backend,
		};
	}

	const timerIds = session.FetchTimerIds() ?? [];
	const threadIds = session.FetchThreadIds() ?? [];
	const frameMin = session.GetFrameIdMin();
	const frameMax = session.GetFrameIdMax();

	// Window resolution. Tail mode keeps the classic "last frame_window frames" behaviour;
	// trigger mode centres the window on the frame that fired the trigger.
	const extraPartialReasons: string[] = [];
	const extraQualityNotes: string[] = [];
	let windowMode = windowSpec.mode === "trigger" ? "trigger" : "tail";
	let frameWindow = normalizeFrameWindow(windowSpec.frame_window);
	const framesBefore = windowSpec.frames_before ?? 0;
	const postTriggerFrames = windowSpec.post_trigger_frames ?? 0;
	let triggerFrameId: number | undefined;
	let triggerFrameAbsoluteId: number | undefined;
	let triggerFrameRelocated = false;
	let preTriggerFramesAvailable: number | undefined;
	let startFrame = math.max(frameMin, frameMax - frameWindow + 1);
	let windowEnd = frameMax;
	// In trigger mode the trigger frame and its post frames form one block that is always
	// walked before anything else.
	let triggerBlockEnd: number | undefined;

	if (windowMode === "trigger") {
		const requestedFrameId = windowSpec.trigger_frame_id ?? 0;
		const requestedAbsoluteId = windowSpec.trigger_frame_absolute_id;
		let resolvedFrameId: number | undefined;

		// The trigger frame is identified by its engine-wide absolute id: session-local
		// frame ids shift every time the 256-frame ring evicts an older frame.
		if (requestedFrameId >= frameMin && requestedFrameId <= frameMax) {
			const [ok, descOrErr] = safeCall(() => session.GetFrameDesc(requestedFrameId));
			if (ok && descOrErr !== undefined) {
				const absoluteId = (descOrErr as FrameDesc).FrameAbsoluteId();
				if (requestedAbsoluteId === undefined || absoluteId === requestedAbsoluteId) {
					resolvedFrameId = requestedFrameId;
					triggerFrameAbsoluteId = absoluteId;
				}
			}
		}
		if (resolvedFrameId === undefined && requestedAbsoluteId !== undefined) {
			for (let frameId = frameMin; frameId <= frameMax; frameId++) {
				const [ok, descOrErr] = safeCall(() => session.GetFrameDesc(frameId));
				if (!ok || descOrErr === undefined) continue;
				const absoluteId = (descOrErr as FrameDesc).FrameAbsoluteId();
				if (absoluteId === requestedAbsoluteId) {
					resolvedFrameId = frameId;
					triggerFrameAbsoluteId = absoluteId;
					triggerFrameRelocated = true;
					break;
				}
			}
		}
		if (resolvedFrameId === undefined && requestedFrameId >= frameMin && requestedFrameId <= frameMax) {
			resolvedFrameId = requestedFrameId;
			extraQualityNotes.push("trigger_frame_absolute_id_mismatch");
		}

		if (resolvedFrameId === undefined) {
			windowMode = "tail";
			extraPartialReasons.push("trigger_frame_not_in_snapshot");
			frameWindow = math.clamp(framesBefore + postTriggerFrames + 1, 1, 2000);
			startFrame = math.max(frameMin, frameMax - frameWindow + 1);
			windowEnd = frameMax;
		} else {
			triggerFrameId = resolvedFrameId;
			const postEnd = math.min(resolvedFrameId + postTriggerFrames, frameMax);
			const preStart = math.max(resolvedFrameId - framesBefore, frameMin);
			startFrame = preStart;
			windowEnd = postEnd;
			triggerBlockEnd = postEnd;
			preTriggerFramesAvailable = resolvedFrameId - preStart;
			if (resolvedFrameId - framesBefore < frameMin) extraPartialReasons.push("pre_trigger_frames_evicted");
		}
	}

	const framesConsidered = windowEnd >= startFrame ? windowEnd - startFrame + 1 : 0;

	// One pass over the selected window (at most 256 frames) so frame stats, trigger
	// checks and frame_breakdown all read the same descs instead of re-fetching views.
	const frameDescs = collectFrameDescs(session, startFrame, windowEnd);
	if (triggerFrameId !== undefined) {
		// Report the absolute id this snapshot actually holds, which differs from the
		// requested one when the trigger frame could only be matched by frame id.
		const triggerDesc = frameDescs.get(triggerFrameId);
		if (triggerDesc !== undefined) triggerFrameAbsoluteId = triggerDesc.frame_absolute_id;
	}

	// frame_breakdown candidates have to be known before the walk starts so per-frame
	// timer totals can be accumulated for exactly those frames.
	const breakdownFrameIds: number[] = [];
	const breakdownFrameSet = new Set<number>();
	if (maxFrameBreakdowns > 0) {
		const candidates: FrameDescInfo[] = [];
		for (let frameId = startFrame; frameId <= windowEnd; frameId++) {
			const desc = frameDescs.get(frameId);
			if (desc === undefined || desc.paused || !desc.duration_valid) continue;
			candidates.push(desc);
		}
		candidates.sort((a, b) => a.duration_us > b.duration_us);
		for (let i = 0; i < math.min(maxFrameBreakdowns, candidates.size()); i++) {
			breakdownFrameIds.push(candidates[i].frame_id);
			breakdownFrameSet.add(candidates[i].frame_id);
		}
		if (triggerFrameId !== undefined && !breakdownFrameSet.has(triggerFrameId) && frameDescs.get(triggerFrameId) !== undefined) {
			breakdownFrameIds.push(triggerFrameId);
			breakdownFrameSet.add(triggerFrameId);
		}
	}

	// Walk order. The frames that matter most go first, so an exhausted max_events budget
	// cuts into the quiet remainder of the window and never into a spike: in trigger mode
	// the trigger frame plus its post frames form the first segment, then every other
	// frame_breakdown candidate gets a one-frame segment of its own (longest first), and
	// whatever is left of the window is walked last in ascending ranges. Scopes that span
	// a segment boundary cannot be matched; they are counted in open_stack_entries_at_end
	// and unmatched_exits rather than silently misattributed.
	const segments: WalkedSegment[] = [];
	const coveredFrames = new Set<number>();
	function pushSegment(segmentStart: number, segmentEnd: number): void {
		if (segmentEnd < segmentStart) return;
		segments.push({ start: segmentStart, end: segmentEnd, walked: false, limited: false });
		for (let frameId = segmentStart; frameId <= segmentEnd; frameId++) coveredFrames.add(frameId);
	}
	if (triggerFrameId !== undefined && triggerBlockEnd !== undefined) {
		pushSegment(triggerFrameId, triggerBlockEnd);
	}
	for (const frameId of breakdownFrameIds) {
		if (coveredFrames.has(frameId)) continue;
		pushSegment(frameId, frameId);
	}
	let rangeStart: number | undefined;
	for (let frameId = startFrame; frameId <= windowEnd + 1; frameId++) {
		const covered = frameId > windowEnd || coveredFrames.has(frameId);
		if (!covered) {
			if (rangeStart === undefined) rangeStart = frameId;
			continue;
		}
		if (rangeStart !== undefined) {
			pushSegment(rangeStart, frameId - 1);
			rangeStart = undefined;
		}
	}

	const groupCache = new Map<number, string>();
	const timerCache = new Map<number, TimerInfo>();
	const threadCache = new Map<number, Record<string, unknown>>();

	function getGroupName(groupId: number | undefined): string | undefined {
		if (groupId === undefined) return undefined;
		const cached = groupCache.get(groupId);
		if (cached !== undefined) return cached;
		const [ok, descOrErr] = safeCall(() => session.FetchGroupDesc(groupId));
		const desc = ok ? descOrErr as GroupDesc | undefined : undefined;
		const name = desc && typeIs(desc.GroupName, "string") && desc.GroupName !== "" ? desc.GroupName : tostring(groupId);
		groupCache.set(groupId, name);
		return name;
	}

	function getTimerInfo(timerId: number): TimerInfo {
		const cached = timerCache.get(timerId);
		if (cached !== undefined) return cached;
		const [ok, descOrErr] = safeCall(() => session.FetchTimerDesc(timerId));
		const desc = ok ? descOrErr as TimerDesc | undefined : undefined;
		const groupId = desc && typeIs(desc.GroupId, "number") ? desc.GroupId : undefined;
		const info: TimerInfo = {
			timer_id: timerId,
			name: desc && typeIs(desc.TimerName, "string") && desc.TimerName !== "" ? desc.TimerName : tostring(timerId),
			group_id: groupId,
			group: getGroupName(groupId),
			is_user_timer: desc && desc.IsUserTimer === true ? true : undefined,
		};
		timerCache.set(timerId, info);
		return info;
	}

	function getThreadInfo(threadId: number): Record<string, unknown> {
		const cached = threadCache.get(threadId);
		if (cached !== undefined) return cached;
		const [ok, descOrErr] = safeCall(() => session.FetchThreadDesc(threadId));
		const desc = ok ? descOrErr as ThreadDesc | undefined : undefined;
		const info: Record<string, unknown> = {
			thread_id: threadId,
			name: desc && typeIs(desc.ThreadName, "string") && desc.ThreadName !== "" ? desc.ThreadName : tostring(threadId),
		};
		if (desc && desc.IsGpu === true) info.is_gpu = true;
		if (desc && typeIs(desc.BufferSize, "number")) info.buffer_size = desc.BufferSize;
		threadCache.set(threadId, info);
		return info;
	}

	function addTimerAggregate(map: Map<number, TimerAggregate>, timerId: number, inclusiveRaw: number, exclusiveRaw: number): void {
		let aggregate = map.get(timerId);
		if (aggregate === undefined) {
			aggregate = { timer_id: timerId, inclusive_raw: 0, exclusive_raw: 0, count: 0, max_raw: 0 };
			map.set(timerId, aggregate);
		}
		aggregate.inclusive_raw += inclusiveRaw;
		aggregate.exclusive_raw += exclusiveRaw;
		aggregate.count += 1;
		if (inclusiveRaw > aggregate.max_raw) aggregate.max_raw = inclusiveRaw;
	}

	const focusMasks = FOCUS_GROUP_MASKS[focus] ?? [];
	const focusGroupIds: number[] = [];
	for (const mask of focusMasks) {
		const [ok, idsOrErr] = safeCall(() => session.FindGroupIds(mask, false));
		if (ok && typeIs(idsOrErr, "table")) {
			for (const id of idsOrErr as number[]) {
				if (!focusGroupIds.includes(id)) focusGroupIds.push(id);
			}
		}
	}

	// Shared by every segment; StartFrameId/EndFrameId are filled in per segment.
	const iteratorConfig: Record<string, unknown> = {
		StartFrameId: startFrame,
		EndFrameId: windowEnd,
		SkipGpuThreads: !includeGpu,
		SkipEvents: true,
		SkipPausedFrames: true,
		SkipFrameBoundaries: true,
	};
	if (focusGroupIds.size() > 0) iteratorConfig.GroupIds = focusGroupIds;

	const stacks = new Map<number, StackEntry[]>();
	const aggregates = new Map<number, TimerAggregate>();
	const timerThreadAggregates = new Map<number, Map<number, TimerAggregate>>();
	const timerFrameAggregates = new Map<number, Map<number, number>>();
	const edgeAggregates = new Map<string, EdgeAggregate>();
	const sampledFrames = new Set<number>();
	let eventsSampled = 0;
	let enterEvents = 0;
	let exitEvents = 0;
	let unmatchedExits = 0;
	let droppedSpans = 0;
	let sampledFrameMin: number | undefined;
	let sampledFrameMax: number | undefined;
	let lastProcessedFrameId: number | undefined;
	let lastProcessedTimestampRaw: number | undefined;
	let openStackEntriesAtEnd = 0;
	// Per-frame timer totals, kept only for the frames that frame_breakdown will report.
	const frameTimerAggregates = new Map<number, Map<number, TimerAggregate>>();

	// Cooperative time budget: this single synchronous pass can walk up to max_events
	// (default 250k, up to 1,000,000) scope records, which runs solid for multiple
	// seconds and freezes the runtime peer's thread — the client shows "Gameplay
	// Paused". Yield to the engine whenever the budget is spent so the current frame can
	// finish. Yielding mid-iteration is safe: the session was opened from a static
	// snapshot buffer (OpenFromBuffer) that nothing mutates while we read it. The clock
	// is sampled only every 512 steps — an os.clock() per record would itself dominate
	// the loop, and 512 records is well under one frame of work.
	const budgetMs = includeGpu || focus === "all" ? 12 : 6;
	let deadlineClock = os.clock() + budgetMs / 1000;

	// Walks one frame range with its own iterator. Every segment shares the aggregation
	// maps and the max_events budget; only the per-thread stacks are reset, because a
	// scope left open at the end of one segment can never be closed by another one.
	// Returns an error message when the iterator could not be configured.
	function walkSegment(segment: WalkedSegment): string | undefined {
		const iterator = session.CreateLogIterator();
		// Tracked per segment: a segment with no events must not inherit the frame the
		// previous segment stopped on.
		let segmentLastFrame: number | undefined;
		const segmentConfig: Record<string, unknown> = {};
		for (const [key, value] of pairs(iteratorConfig)) segmentConfig[key as string] = value;
		segmentConfig.StartFrameId = segment.start;
		segmentConfig.EndFrameId = segment.end;
		const [configOk, configErr] = safeCall(() => {
			iterator.Configure(segmentConfig);
			return true;
		});
		if (!configOk) {
			iterator.Dispose();
			return tostring(configErr);
		}

		while (eventsSampled < maxEvents && iterator.Step()) {
			eventsSampled += 1;
			if (eventsSampled % 512 === 0 && os.clock() > deadlineClock) {
				RunService.Heartbeat.Wait();
				deadlineClock = os.clock() + budgetMs / 1000;
			}
			const state = iterator.GetState();
			if (!state) continue;
			const frameId = state.FrameId();
			const threadId = state.ThreadId();
			const timerId = state.TimerId();
			const timestampRaw = state.Timestamp();
			lastProcessedFrameId = frameId;
			lastProcessedTimestampRaw = timestampRaw;
			segmentLastFrame = frameId;
			if (frameId > 0) {
				sampledFrames.add(frameId);
				if (sampledFrameMin === undefined || frameId < sampledFrameMin) sampledFrameMin = frameId;
				if (sampledFrameMax === undefined || frameId > sampledFrameMax) sampledFrameMax = frameId;
			}
			let stack = stacks.get(threadId);
			if (stack === undefined) {
				stack = [];
				stacks.set(threadId, stack);
			}

			if (state.IsEnter()) {
				enterEvents += 1;
				stack.push({ timerId, timestampRaw, childRaw: 0, frameId });
			} else if (state.IsExit()) {
				exitEvents += 1;
				let entry: StackEntry | undefined;
				while (stack.size() > 0) {
					const candidate = stack.pop();
					if (candidate && candidate.timerId === timerId) {
						entry = candidate;
						break;
					}
				}
				if (entry === undefined) {
					unmatchedExits += 1;
					continue;
				}
				const inclusiveRaw = timestampRaw - entry.timestampRaw;
				if (inclusiveRaw < 0 || inclusiveRaw > 1000000000000) {
					droppedSpans += 1;
					continue;
				}
				const exclusiveRaw = math.max(0, inclusiveRaw - entry.childRaw);
				const parent = stack[stack.size() - 1];
				if (parent !== undefined) {
					parent.childRaw += inclusiveRaw;
					const edgeKey = `${parent.timerId}:${timerId}`;
					let edge = edgeAggregates.get(edgeKey);
					if (edge === undefined) {
						edge = { parent_timer_id: parent.timerId, child_timer_id: timerId, inclusive_raw: 0, count: 0, max_raw: 0 };
						edgeAggregates.set(edgeKey, edge);
					}
					edge.inclusive_raw += inclusiveRaw;
					edge.count += 1;
					if (inclusiveRaw > edge.max_raw) edge.max_raw = inclusiveRaw;
				}

				addTimerAggregate(aggregates, timerId, inclusiveRaw, exclusiveRaw);
				const attributionFrameId = entry.frameId > 0 ? entry.frameId : frameId;
				let frameMap = timerFrameAggregates.get(timerId);
				if (frameMap === undefined) {
					frameMap = new Map<number, number>();
					timerFrameAggregates.set(timerId, frameMap);
				}
				addFrameRaw(frameMap, attributionFrameId, inclusiveRaw);
				if (breakdownFrameSet.has(attributionFrameId)) {
					let perFrameTimers = frameTimerAggregates.get(attributionFrameId);
					if (perFrameTimers === undefined) {
						perFrameTimers = new Map<number, TimerAggregate>();
						frameTimerAggregates.set(attributionFrameId, perFrameTimers);
					}
					addTimerAggregate(perFrameTimers, timerId, inclusiveRaw, exclusiveRaw);
				}
				let threadMap = timerThreadAggregates.get(timerId);
				if (threadMap === undefined) {
					threadMap = new Map<number, TimerAggregate>();
					timerThreadAggregates.set(timerId, threadMap);
				}
				addTimerAggregate(threadMap, threadId, inclusiveRaw, exclusiveRaw);
			}
		}

		segment.walked = true;
		segment.last_frame_id = segmentLastFrame;
		segment.limited = eventsSampled >= maxEvents;
		// Scopes still open when a segment ends can never be closed by another segment.
		for (const [, stack] of stacks) openStackEntriesAtEnd += stack.size();
		stacks.clear();
		iterator.Dispose();
		return undefined;
	}

	let segmentsSkipped = 0;
	let preTriggerSegmentSkipped = false;
	for (let i = 0; i < segments.size(); i++) {
		const segment = segments[i];
		if (eventsSampled >= maxEvents) {
			// An earlier segment ate the whole event budget; the rest stay unwalked rather
			// than half-walked.
			segmentsSkipped += 1;
			if (triggerFrameId !== undefined && segment.end < triggerFrameId) preTriggerSegmentSkipped = true;
			continue;
		}
		const walkError = walkSegment(segment);
		if (walkError !== undefined) {
			session.Dispose();
			return {
				error: "micro_profiler_iterator_config_failed",
				message: walkError,
				backend,
			};
		}
	}
	if (segmentsSkipped > 0) extraPartialReasons.push("segments_skipped_after_event_limit");
	if (preTriggerSegmentSkipped) extraPartialReasons.push("pre_trigger_segment_skipped");

	const walkedSegments: WalkedSegment[] = [];
	for (const segment of segments) {
		if (segment.walked) walkedSegments.push(segment);
	}

	const sampledFrameCoveragePct = percent(sampledFrames.size(), framesConsidered);
	// frame_summary covers exactly the frames the walk reached: every frame of a walked
	// segment, clipped at the frame the event budget ran out on.
	const walkedFrameIds: number[] = [];
	for (const segment of walkedSegments) {
		const walkedEnd = segment.limited && segment.last_frame_id !== undefined ? math.min(segment.end, segment.last_frame_id) : segment.end;
		for (let frameId = segment.start; frameId <= walkedEnd; frameId++) walkedFrameIds.push(frameId);
	}
	walkedFrameIds.sort((a, b) => a < b);
	const analysisFrameMin = walkedFrameIds.size() > 0 ? walkedFrameIds[0] : (sampledFrameMin ?? startFrame);
	const analysisFrameMax = walkedFrameIds.size() > 0 ? walkedFrameIds[walkedFrameIds.size() - 1] : (sampledFrameMax ?? windowEnd);
	const frameSummary = collectFrameSummary(frameDescs, walkedFrameIds, triggerFrameId);
	const analysisFrameCount = typeIs(frameSummary.frames, "number") && (frameSummary.frames as number) > 0
		? frameSummary.frames as number
		: sampledFrames.size() > 0
			? sampledFrames.size()
			: framesConsidered;
	const analysisDurationUs = typeIs(frameSummary.total_duration_us, "number") && (frameSummary.total_duration_us as number) > 0
		? frameSummary.total_duration_us as number
		: fallbackDurationUs;
	const analysisDurationMs = analysisDurationUs / 1000;

	const rows: Record<string, unknown>[] = [];
	const rowsByTimerId = new Map<number, Record<string, unknown>>();
	const groupAggregates = new Map<string, GroupAggregate>();
	const groupTimerRows = new Map<string, Record<string, unknown>[]>();
	const groupFrameAggregates = new Map<string, Map<number, number>>();
	const threadAggregates = new Map<number, TimerAggregate>();
	const threadTimerRows = new Map<number, Record<string, unknown>[]>();
	let omittedIdle = 0;
	let omittedBelowThreshold = 0;
	let omittedByFilter = 0;

	for (const [timerId, aggregate] of aggregates) {
		const info = getTimerInfo(timerId);
		const totalUs = rawToUs(aggregate.inclusive_raw);
		if (!includeIdle && isIdleTimer(info)) {
			omittedIdle += 1;
			continue;
		}
		if (totalUs < minTotalUs) {
			omittedBelowThreshold += 1;
			continue;
		}
		if (filter !== undefined) {
			const searchable = `${info.name} ${info.group ?? ""}`;
			if (!stringContains(searchable, filter)) {
				omittedByFilter += 1;
				continue;
			}
		}

		const group = info.group ?? "<unknown>";
		const inclusiveUs = rawToUs(aggregate.inclusive_raw);
		const exclusiveUs = rawToUs(aggregate.exclusive_raw);
		const avgUs = aggregate.count > 0 ? round2(totalUs / aggregate.count) : 0;
		const maxUs = rawToUs(aggregate.max_raw);
		let groupAgg = groupAggregates.get(group);
		if (groupAgg === undefined) {
			groupAgg = { group, inclusive_raw: 0, exclusive_raw: 0, count: 0 };
			groupAggregates.set(group, groupAgg);
		}
		groupAgg.inclusive_raw += aggregate.inclusive_raw;
		groupAgg.exclusive_raw += aggregate.exclusive_raw;
		groupAgg.count += aggregate.count;

		const row: Record<string, unknown> = {
			timer_id: timerId,
			name: info.name,
			group,
			inclusive_us: inclusiveUs,
			inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
			exclusive_us: exclusiveUs,
			exclusive_pct: percent(exclusiveUs, inclusiveUs),
			count: aggregate.count,
			count_per_s: perSecond(aggregate.count, analysisDurationMs),
			count_per_frame: analysisFrameCount > 0 ? round2(aggregate.count / analysisFrameCount) : aggregate.count,
			avg_invocation_us: avgUs,
			max_invocation_us: maxUs,
			pct_of_analyzed_wall: percent(inclusiveUs, analysisDurationUs),
		};
		const maxToAvg = ratio(maxUs, avgUs);
		if (maxToAvg !== undefined) row.max_to_avg = maxToAvg;
		const timerFrameImpact = summarizeFrameImpact(timerFrameAggregates.get(timerId), analysisFrameCount);
		for (const [key, value] of pairs(timerFrameImpact)) {
			row[key as string] = value;
		}
		if (info.is_user_timer === true) row.is_user_timer = true;
		rows.push(row);
		rowsByTimerId.set(timerId, row);
		let timerRows = groupTimerRows.get(group);
		if (timerRows === undefined) {
			timerRows = [];
			groupTimerRows.set(group, timerRows);
		}
		timerRows.push(row);
		const timerFrames = timerFrameAggregates.get(timerId);
		if (timerFrames !== undefined) {
			let groupFrames = groupFrameAggregates.get(group);
			if (groupFrames === undefined) {
				groupFrames = new Map<number, number>();
				groupFrameAggregates.set(group, groupFrames);
			}
			for (const [frameId, raw] of timerFrames) addFrameRaw(groupFrames, frameId, raw);
		}

		const perThread = timerThreadAggregates.get(timerId);
		if (perThread !== undefined) {
			const timerThreadSummaryRows: Record<string, unknown>[] = [];
			for (const [threadId, threadAggregate] of perThread) {
				let threadAggregateRow = threadAggregates.get(threadId);
				if (threadAggregateRow === undefined) {
					threadAggregateRow = { timer_id: threadId, inclusive_raw: 0, exclusive_raw: 0, count: 0, max_raw: 0 };
					threadAggregates.set(threadId, threadAggregateRow);
				}
				threadAggregateRow.inclusive_raw += threadAggregate.inclusive_raw;
				threadAggregateRow.exclusive_raw += threadAggregate.exclusive_raw;
				threadAggregateRow.count += threadAggregate.count;
				if (threadAggregate.max_raw > threadAggregateRow.max_raw) threadAggregateRow.max_raw = threadAggregate.max_raw;

				let threadRows = threadTimerRows.get(threadId);
				if (threadRows === undefined) {
					threadRows = [];
					threadTimerRows.set(threadId, threadRows);
				}
				const threadTotalUs = rawToUs(threadAggregate.inclusive_raw);
				const threadExclusiveUs = rawToUs(threadAggregate.exclusive_raw);
				const threadAvgUs = threadAggregate.count > 0 ? round2(threadTotalUs / threadAggregate.count) : 0;
				const threadInfo = getThreadInfo(threadId);
				const threadTimerRow: Record<string, unknown> = {
					thread_id: threadId,
					thread_name: threadInfo.name,
					is_gpu: threadInfo.is_gpu,
					timer_id: timerId,
					name: info.name,
					group,
					inclusive_us: threadTotalUs,
					inclusive_us_per_s: perSecond(threadTotalUs, analysisDurationMs),
					exclusive_us: threadExclusiveUs,
					count: threadAggregate.count,
					count_per_s: perSecond(threadAggregate.count, analysisDurationMs),
					avg_invocation_us: threadAvgUs,
					max_invocation_us: rawToUs(threadAggregate.max_raw),
				};
				const threadMaxToAvg = ratio(threadTimerRow.max_invocation_us as number, threadAvgUs);
				if (threadMaxToAvg !== undefined) threadTimerRow.max_to_avg = threadMaxToAvg;
				threadRows.push(threadTimerRow);
				timerThreadSummaryRows.push({
					thread_id: threadId,
					thread_name: threadInfo.name,
					is_gpu: threadInfo.is_gpu,
					inclusive_us: threadTotalUs,
					exclusive_us: threadExclusiveUs,
					count: threadAggregate.count,
				});
			}
			timerThreadSummaryRows.sort((a, b) => (a.inclusive_us as number) > (b.inclusive_us as number));
			if (maxRelatedTimers > 0 && timerThreadSummaryRows.size() > 0) {
				const topTimerThreads: Record<string, unknown>[] = [];
				for (let i = 0; i < math.min(maxRelatedTimers, timerThreadSummaryRows.size()); i++) topTimerThreads.push(timerThreadSummaryRows[i]);
				row.top_threads = topTimerThreads;
			}
		}
	}

	rows.sort((a, b) => (a.inclusive_us as number) > (b.inclusive_us as number));

	const edgeRows: Record<string, unknown>[] = [];
	const parentRelationsByChild = new Map<number, Record<string, unknown>[]>();
	const childRelationsByParent = new Map<number, Record<string, unknown>[]>();
	for (const [, edge] of edgeAggregates) {
		const parentRow = rowsByTimerId.get(edge.parent_timer_id);
		const childRow = rowsByTimerId.get(edge.child_timer_id);
		if (parentRow === undefined || childRow === undefined) continue;
		const inclusiveUs = rawToUs(edge.inclusive_raw);
		const maxUs = rawToUs(edge.max_raw);
		const avgUs = edge.count > 0 ? round2(inclusiveUs / edge.count) : 0;
		const edgeRow: Record<string, unknown> = {
			parent: {
				timer_id: edge.parent_timer_id,
				name: parentRow.name,
				group: parentRow.group,
			},
			child: {
				timer_id: edge.child_timer_id,
				name: childRow.name,
				group: childRow.group,
			},
			inclusive_us: inclusiveUs,
			inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
			count: edge.count,
			count_per_s: perSecond(edge.count, analysisDurationMs),
			avg_invocation_us: avgUs,
			max_invocation_us: maxUs,
		};
		const maxToAvg = ratio(maxUs, avgUs);
		if (maxToAvg !== undefined) edgeRow.max_to_avg = maxToAvg;
		edgeRows.push(edgeRow);

		let parentRelations = parentRelationsByChild.get(edge.child_timer_id);
		if (parentRelations === undefined) {
			parentRelations = [];
			parentRelationsByChild.set(edge.child_timer_id, parentRelations);
		}
		parentRelations.push({
			timer_id: edge.parent_timer_id,
			name: parentRow.name,
			group: parentRow.group,
			inclusive_us: inclusiveUs,
			count: edge.count,
			pct_of_timer_inclusive: percent(inclusiveUs, childRow.inclusive_us as number),
		});

		let childRelations = childRelationsByParent.get(edge.parent_timer_id);
		if (childRelations === undefined) {
			childRelations = [];
			childRelationsByParent.set(edge.parent_timer_id, childRelations);
		}
		childRelations.push({
			timer_id: edge.child_timer_id,
			name: childRow.name,
			group: childRow.group,
			inclusive_us: inclusiveUs,
			count: edge.count,
			pct_of_timer_inclusive: percent(inclusiveUs, parentRow.inclusive_us as number),
		});
	}
	edgeRows.sort((a, b) => (a.inclusive_us as number) > (b.inclusive_us as number));
	if (maxRelatedTimers > 0) {
		for (const [, relationRows] of parentRelationsByChild) {
			relationRows.sort((a, b) => (a.inclusive_us as number) > (b.inclusive_us as number));
		}
		for (const [, relationRows] of childRelationsByParent) {
			relationRows.sort((a, b) => (a.inclusive_us as number) > (b.inclusive_us as number));
		}
		for (const row of rows) {
			const timerId = row.timer_id as number;
			const parents = parentRelationsByChild.get(timerId);
			const children = childRelationsByParent.get(timerId);
			if (parents !== undefined && parents.size() > 0) {
				const topParents: Record<string, unknown>[] = [];
				for (let i = 0; i < math.min(maxRelatedTimers, parents.size()); i++) topParents.push(parents[i]);
				row.top_parents = topParents;
			}
			if (children !== undefined && children.size() > 0) {
				const topChildren: Record<string, unknown>[] = [];
				for (let i = 0; i < math.min(maxRelatedTimers, children.size()); i++) topChildren.push(children[i]);
				row.top_children = topChildren;
			}
		}
	}

	const topTimers: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxTimers, rows.size()); i++) {
		const row = copyRecord(rows[i]);
		row.rank = i + 1;
		topTimers.push(row);
	}

	const rowsByExclusive: Record<string, unknown>[] = [];
	for (const row of rows) rowsByExclusive.push(row);
	rowsByExclusive.sort((a, b) => (a.exclusive_us as number) > (b.exclusive_us as number));
	const topTimersByExclusive: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxTimers, rowsByExclusive.size()); i++) {
		const row = copyRecord(rowsByExclusive[i]);
		row.rank = i + 1;
		topTimersByExclusive.push(row);
	}

	const topEdges: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxTimers, edgeRows.size()); i++) {
		const row = copyRecord(edgeRows[i]);
		row.rank = i + 1;
		topEdges.push(row);
	}

	const threadRows: Record<string, unknown>[] = [];
	for (const [threadId, aggregate] of threadAggregates) {
		const info = getThreadInfo(threadId);
		const inclusiveUs = rawToUs(aggregate.inclusive_raw);
		const exclusiveUs = rawToUs(aggregate.exclusive_raw);
		const row: Record<string, unknown> = {
			thread_id: threadId,
			thread_name: info.name,
			is_gpu: info.is_gpu,
			inclusive_us: inclusiveUs,
			inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
			exclusive_us: exclusiveUs,
			exclusive_pct: percent(exclusiveUs, inclusiveUs),
			count: aggregate.count,
			count_per_s: perSecond(aggregate.count, analysisDurationMs),
			max_invocation_us: rawToUs(aggregate.max_raw),
			pct_of_analyzed_wall: percent(inclusiveUs, analysisDurationUs),
		};
		const timerRows = threadTimerRows.get(threadId) ?? [];
		timerRows.sort((a, b) => (a.inclusive_us as number) > (b.inclusive_us as number));
		const topThreadTimers: Record<string, unknown>[] = [];
		for (let i = 0; i < math.min(maxTimersPerGroup, timerRows.size()); i++) {
			const timerRow = copyRecord(timerRows[i]);
			topThreadTimers.push(timerRow);
		}
		if (topThreadTimers.size() > 0) row.top_timers = topThreadTimers;
		threadRows.push(row);
	}
	threadRows.sort((a, b) => (a.inclusive_us as number) > (b.inclusive_us as number));
	const topThreads: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxGroups, threadRows.size()); i++) {
		const row = threadRows[i];
		row.rank = i + 1;
		topThreads.push(row);
	}

	const groupRows: Record<string, unknown>[] = [];
	for (const [, aggregate] of groupAggregates) {
		const timerRows = groupTimerRows.get(aggregate.group) ?? [];
		timerRows.sort((a, b) => (a.inclusive_us as number) > (b.inclusive_us as number));
		const topGroupTimers: Record<string, unknown>[] = [];
		for (let i = 0; i < math.min(maxTimersPerGroup, timerRows.size()); i++) {
			const timerRow = timerRows[i];
			topGroupTimers.push({
				timer_id: timerRow.timer_id,
				name: timerRow.name,
				inclusive_us: timerRow.inclusive_us,
				inclusive_us_per_s: timerRow.inclusive_us_per_s,
				exclusive_us: timerRow.exclusive_us,
				count: timerRow.count,
				max_invocation_us: timerRow.max_invocation_us,
				max_frame_inclusive_us: timerRow.max_frame_inclusive_us,
			});
		}
		const inclusiveUs = rawToUs(aggregate.inclusive_raw);
		const exclusiveUs = rawToUs(aggregate.exclusive_raw);
		const groupRow: Record<string, unknown> = {
			group: aggregate.group,
			inclusive_us: inclusiveUs,
			inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
			exclusive_us: exclusiveUs,
			exclusive_pct: percent(exclusiveUs, inclusiveUs),
			count: aggregate.count,
			count_per_s: perSecond(aggregate.count, analysisDurationMs),
			count_per_frame: analysisFrameCount > 0 ? round2(aggregate.count / analysisFrameCount) : aggregate.count,
			timer_count: timerRows.size(),
			pct_of_analyzed_wall: percent(inclusiveUs, analysisDurationUs),
		};
		const groupFrameImpact = summarizeFrameImpact(groupFrameAggregates.get(aggregate.group), analysisFrameCount);
		for (const [key, value] of pairs(groupFrameImpact)) {
			groupRow[key as string] = value;
		}
		if (topGroupTimers.size() > 0) groupRow.top_timers = topGroupTimers;
		groupRows.push(groupRow);
	}
	groupRows.sort((a, b) => (a.inclusive_us as number) > (b.inclusive_us as number));
	const topGroups: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxGroups, groupRows.size()); i++) {
		const row = copyRecord(groupRows[i]);
		row.rank = i + 1;
		topGroups.push(row);
	}

	const groupRowsByExclusive: Record<string, unknown>[] = [];
	for (const row of groupRows) groupRowsByExclusive.push(row);
	groupRowsByExclusive.sort((a, b) => (a.exclusive_us as number) > (b.exclusive_us as number));
	const topGroupsByExclusive: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxGroups, groupRowsByExclusive.size()); i++) {
		const row = copyRecord(groupRowsByExclusive[i]);
		row.rank = i + 1;
		topGroupsByExclusive.push(row);
	}

	const omitted: Record<string, number> = {};
	if (omittedIdle > 0) omitted.idle = omittedIdle;
	if (omittedBelowThreshold > 0) omitted.below_min_total_us = omittedBelowThreshold;
	if (omittedByFilter > 0) omitted.filtered_out = omittedByFilter;

	const eventLimitHit = eventsSampled >= maxEvents;
	const iteratorFinished = eventsSampled < maxEvents;
	const partialReasons: string[] = [];
	if (eventLimitHit) partialReasons.push("event_limit_hit");
	if (openStackEntriesAtEnd > 0) partialReasons.push("open_stack_entries_at_end");
	if (sampledFrameCoveragePct < 100) partialReasons.push("selected_frame_event_coverage_below_100");
	for (const reason of extraPartialReasons) partialReasons.push(reason);

	// Per-frame timer tables for the longest frames in the window (and the trigger frame).
	const frameBreakdown: Record<string, unknown>[] = [];
	for (const frameId of breakdownFrameIds) {
		const desc = frameDescs.get(frameId);
		if (desc === undefined) continue;
		let walkedSegment: WalkedSegment | undefined;
		for (const segment of walkedSegments) {
			if (frameId >= segment.start && frameId <= segment.end) {
				walkedSegment = segment;
				break;
			}
		}
		let partial = walkedSegment === undefined;
		if (walkedSegment !== undefined && walkedSegment.limited) {
			const segmentLastFrame = walkedSegment.last_frame_id;
			// The event budget ran out inside this segment, so the frame it stopped on was
			// only walked up to that point.
			if (segmentLastFrame === undefined || frameId >= segmentLastFrame) partial = true;
		}

		const perFrameTimers = frameTimerAggregates.get(frameId);
		const frameTimerRows: Record<string, unknown>[] = [];
		if (perFrameTimers !== undefined) {
			for (const [timerId, aggregate] of perFrameTimers) {
				const info = getTimerInfo(timerId);
				if (!includeIdle && isIdleTimer(info)) continue;
				if (filter !== undefined && !stringContains(`${info.name} ${info.group ?? ""}`, filter)) continue;
				frameTimerRows.push({
					group: info.group ?? "<unknown>",
					name: info.name,
					timer_id: timerId,
					inclusive_us: rawToUs(aggregate.inclusive_raw),
					exclusive_us: rawToUs(aggregate.exclusive_raw),
					count: aggregate.count,
				});
			}
		}
		frameTimerRows.sort((a, b) => (a.exclusive_us as number) > (b.exclusive_us as number));
		const topFrameTimers: Record<string, unknown>[] = [];
		for (let i = 0; i < math.min(MAX_FRAME_BREAKDOWN_TIMERS, frameTimerRows.size()); i++) {
			topFrameTimers.push(frameTimerRows[i]);
		}

		const breakdownRow: Record<string, unknown> = {
			frame_id: frameId,
			frame_absolute_id: desc.frame_absolute_id,
			duration_us: desc.duration_us,
			timer_count: frameTimerRows.size(),
			top_timers: topFrameTimers,
		};
		if (triggerFrameId !== undefined && frameId === triggerFrameId) breakdownRow.is_trigger_frame = true;
		if (desc.incomplete) breakdownRow.incomplete = true;
		if (partial) breakdownRow.partial = true;
		frameBreakdown.push(breakdownRow);
	}

	let comparisonIndex: Record<string, unknown> | undefined;
	if (includeComparisonIndex) {
		const timerFields = [
			"timer_id",
			"name",
			"group",
			"inclusive_us",
			"inclusive_us_per_s",
			"exclusive_us",
			"count",
			"count_per_s",
			"active_frame_count",
			"inclusive_us_per_frame",
			"max_frame_inclusive_us",
			"max_frame_id",
		];
		const groupFields = [
			"group",
			"inclusive_us",
			"inclusive_us_per_s",
			"exclusive_us",
			"count",
			"timer_count",
			"active_frame_count",
			"inclusive_us_per_frame",
			"max_frame_inclusive_us",
			"max_frame_id",
		];
		const threadFields = [
			"thread_id",
			"thread_name",
			"is_gpu",
			"inclusive_us",
			"inclusive_us_per_s",
			"exclusive_us",
			"count",
		];
		const edgeFields = [
			"parent",
			"child",
			"inclusive_us",
			"inclusive_us_per_s",
			"count",
			"max_invocation_us",
		];
		const timerIndex: Record<string, unknown>[] = [];
		for (const row of rows) timerIndex.push(pickFields(row, timerFields));
		const groupIndex: Record<string, unknown>[] = [];
		for (const row of groupRows) groupIndex.push(pickFields(row, groupFields));
		const threadIndex: Record<string, unknown>[] = [];
		for (const row of threadRows) threadIndex.push(pickFields(row, threadFields));
		const edgeIndex: Record<string, unknown>[] = [];
		for (const row of edgeRows) edgeIndex.push(pickFields(row, edgeFields));
		comparisonIndex = {
			timers: timerIndex,
			groups: groupIndex,
			threads: threadIndex,
			call_edges: edgeIndex,
		};
	}

	const analysisWindow: Record<string, unknown> = {
		mode: windowMode,
		requested_duration_ms: durationMs,
		analysis_duration_us: analysisDurationUs,
		snapshot_frame_min: frameMin,
		snapshot_frame_max: frameMax,
		selected_frame_min: startFrame,
		selected_frame_max: windowEnd,
		selected_frame_count: framesConsidered,
		analyzed_frame_min: analysisFrameMin,
		analyzed_frame_max: analysisFrameMax,
		analyzed_frame_count: analysisFrameCount,
		processed_frame_min: sampledFrameMin,
		processed_frame_max: sampledFrameMax,
		processed_frame_count: sampledFrames.size(),
		selected_frame_event_coverage_pct: sampledFrameCoveragePct,
	};
	const segmentRows: Record<string, unknown>[] = [];
	for (const segment of segments) {
		const segmentRow: Record<string, unknown> = { start_frame: segment.start, end_frame: segment.end, walked: segment.walked };
		if (segment.limited) segmentRow.event_limit_hit = true;
		segmentRows.push(segmentRow);
	}
	analysisWindow.segments = segmentRows;
	if (segmentsSkipped > 0) analysisWindow.segments_skipped = segmentsSkipped;
	if (windowMode === "tail") {
		analysisWindow.frame_window = frameWindow;
	} else {
		analysisWindow.trigger_frame_id = triggerFrameId;
		analysisWindow.trigger_frame_absolute_id = triggerFrameAbsoluteId ?? windowSpec.trigger_frame_absolute_id;
		analysisWindow.frames_before = framesBefore;
		analysisWindow.post_trigger_frames = postTriggerFrames;
		if (triggerFrameRelocated) analysisWindow.trigger_frame_relocated = true;
		if (preTriggerFramesAvailable !== undefined) analysisWindow.pre_trigger_frames_available = preTriggerFramesAvailable;
	}

	const applied: Record<string, unknown> = {
		focus,
		filter: filter ?? undefined,
		include_idle: includeIdle,
		include_gpu: includeGpu,
		min_total_us: minTotalUs,
		max_groups: maxGroups,
		max_timers: maxTimers,
		max_timers_per_group: maxTimersPerGroup,
		max_related_timers: maxRelatedTimers,
		max_events: maxEvents,
		frame_window: frameWindow,
		max_frame_breakdowns: maxFrameBreakdowns,
		window_mode: windowMode,
		sort: "inclusive_us_desc",
	};
	if (windowMode === "trigger") {
		applied.frames_before = framesBefore;
		applied.post_trigger_frames = postTriggerFrames;
	}

	const qualityNotes: string[] = [];
	if (focus !== "all") {
		qualityNotes.push("focus filters events before stack aggregation; exclusive_us is exclusive within emitted focused events, not the full snapshot.");
	}
	for (const note of extraQualityNotes) qualityNotes.push(note);
	if (segments.size() > 1) {
		qualityNotes.push(`window walked as ${segments.size()} segments, spike frames first; scopes spanning a segment boundary are unmatched and counted in open_stack_entries_at_end / unmatched_exits.`);
	}

	const result: Record<string, unknown> = {
		schema_version: 2,
		ok: true,
		duration_ms: durationMs,
		target: targetRole,
		scope: "micro_profiler",
		time_unit: "microseconds",
		time_basis: "LibMP MicroProfiler timestamps converted from nanosecond ticks. inclusive_us is cumulative nested timer time and can overlap across nested timers/threads; do not sum rows as total frame time.",
		analysis_window: analysisWindow,
		applied,
		counts: {
			buffer_bytes: buffer.len(snapshot),
			timers: timerIds.size(),
			threads: threadIds.size(),
			frame_min: frameMin,
			frame_max: frameMax,
			frames_considered: framesConsidered,
			sampled_frame_min: sampledFrameMin,
			sampled_frame_max: sampledFrameMax,
			sampled_frames: sampledFrames.size(),
			events_sampled: eventsSampled,
			enter_events: enterEvents,
			exit_events: exitEvents,
			unmatched_exits: unmatchedExits,
			dropped_spans: droppedSpans,
			open_stack_entries_at_end: openStackEntriesAtEnd,
			iterator_finished: iteratorFinished,
			last_processed_frame_id: lastProcessedFrameId,
			last_processed_timestamp_us: lastProcessedTimestampRaw !== undefined ? rawToUs(lastProcessedTimestampRaw) : undefined,
			event_limit_hit: eventLimitHit,
		},
		frame_summary: frameSummary,
		frame_breakdown: frameBreakdown,
		top_groups: topGroups,
		top_groups_by_exclusive: topGroupsByExclusive,
		top_threads: topThreads,
		top_call_edges: topEdges,
		top_timers: topTimers,
		top_timers_by_exclusive: topTimersByExclusive,
		data_quality: {
			event_limit_hit: eventLimitHit,
			iterator_finished: iteratorFinished,
			warmup_frames_absorbed: warmupFramesAbsorbed,
			unmatched_exits: unmatchedExits,
			dropped_spans: droppedSpans,
			open_stack_entries_at_end: openStackEntriesAtEnd,
			selected_frame_event_coverage_pct: sampledFrameCoveragePct,
			partial: partialReasons.size() > 0,
			partial_reasons: partialReasons,
			notes: qualityNotes.size() > 0 ? qualityNotes : undefined,
		},
		recommended_tools: recommendedToolsForGroups(topGroups, targetRole),
	};
	if (next(omitted)[0] !== undefined) result.omitted = omitted;
	if (comparisonIndex !== undefined) result.comparison_index = comparisonIndex;
	result.backend = backend;
	if (session.GetDataFormatVersion() !== undefined) result.libmp_data_format_version = session.GetDataFormatVersion();
	if (session.GetObjSize() !== undefined) result.snapshot_object_size_bytes = session.GetObjSize();
	if (includeRawBuffer) result.raw_snapshot_base64 = encodeBase64(snapshot);

	session.Dispose();
	return result;
}

interface BackendCheck {
	backend: Record<string, unknown>;
	error?: Record<string, unknown>;
}

function normalizeTargetRole(requestData: Record<string, unknown>): string {
	return typeIs(requestData.__mcp_target_role, "string") ? requestData.__mcp_target_role as string : "runtime";
}

// Analysis settings are re-read on every call, so action="analyze" can re-slice a stored
// snapshot with a different focus/filter/limits without capturing anything again.
function buildAnalysisSettings(requestData: Record<string, unknown>): AnalysisSettings {
	return {
		maxTimers: normalizeMaxTimers(requestData.max_timers),
		maxGroups: normalizeMaxGroups(requestData.max_groups),
		maxTimersPerGroup: normalizeMaxTimersPerGroup(requestData.max_timers_per_group),
		maxRelatedTimers: normalizeMaxRelatedTimers(requestData.max_related_timers),
		maxEvents: normalizeMaxEvents(requestData.max_events),
		minTotalUs: normalizeMinTotalUs(requestData.min_total_us),
		focus: normalizeFocus(requestData.focus),
		filter: typeIs(requestData.filter, "string") && requestData.filter !== "" ? requestData.filter as string : undefined,
		includeIdle: requestData.include_idle === true,
		includeGpu: requestData.include_gpu === true,
		includeRawBuffer: requestData.__mcp_include_raw_buffer === true,
		includeComparisonIndex: requestData.__mcp_include_comparison_index === true,
		targetRole: normalizeTargetRole(requestData),
		maxFrameBreakdowns: normalizeMaxFrameBreakdowns(requestData.max_frame_breakdowns),
	};
}

function checkBackend(LibMP: LibMPLike): BackendCheck {
	const [probeOk, probeOrErr] = safeCall(() => {
		const info: Record<string, unknown> = {
			accessible: LibMP.Control.IsBackendAccessible(),
			ready: LibMP.Control.IsBackendReady(),
			compatible: LibMP.Control.IsBackendVersionCompatible(),
			versions: LibMP.Versions,
		};
		return info;
	});
	const backend = probeOk && typeIs(probeOrErr, "table")
		? probeOrErr as Record<string, unknown>
		: { accessible: false, ready: false, compatible: false, versions: LibMP.Versions };
	if (backend.accessible !== true || backend.ready !== true || backend.compatible !== true) {
		return {
			backend,
			error: {
				error: "micro_profiler_backend_unavailable",
				message: "MicroProfilerService backend is not accessible, ready, and compatible in this runtime peer.",
				backend,
			},
		};
	}
	return { backend };
}

function createCaptureRecord(kind: string, targetRole: string): CaptureRecord {
	captureCounter += 1;
	const [safeRole] = string.gsub(targetRole, "%W", "_");
	const suffix = string.lower(string.sub(HttpService.GenerateGUID(false), 1, 8));
	return {
		capture_id: `mp_${safeRole}_${captureCounter}_${suffix}`,
		kind,
		status: "armed",
		target: targetRole,
		created_clock: os.clock(),
		created_at_ms: DateTime.now().UnixTimestampMillis,
		arm_timeout_ms: DEFAULT_ARM_TIMEOUT_MS,
		frames_before: DEFAULT_FRAMES_BEFORE,
		post_trigger_frames: DEFAULT_POST_TRIGGER_FRAMES,
		observed: {
			frames_seen: 0,
			max_frame_us: 0,
			max_frame_id: 0,
			max_frame_absolute_id: 0,
			total_frame_us: 0,
			watcher_total_us: 0,
			watcher_samples: 0,
		},
		warmup_frames_absorbed: 0,
		warming_up: false,
		connections: [],
		cancel_requested: false,
	};
}

function registerCapture(record: CaptureRecord): void {
	captures.set(record.capture_id, record);
	captureOrder.push(record.capture_id);
}

function isFinishedStatus(status: string): boolean {
	return status === "done" || status === "timed_out" || status === "cancelled" || status === "failed";
}

// Retention: a full 256-frame snapshot is around 14 MB, so only the newest few are kept
// alive for action="analyze". Armed and triggered records are never touched here.
function pruneCaptures(): void {
	const now = os.clock();
	const survivors: string[] = [];
	for (const captureId of captureOrder) {
		const record = captures.get(captureId);
		if (record === undefined) continue;
		if (isFinishedStatus(record.status) && record.finished_clock !== undefined && now - record.finished_clock > RETAIN_CAPTURE_SECONDS) {
			record.snapshot = undefined;
			captures.delete(captureId);
			continue;
		}
		survivors.push(captureId);
	}

	const withSnapshots: CaptureRecord[] = [];
	for (const captureId of survivors) {
		const record = captures.get(captureId);
		if (record !== undefined && record.snapshot !== undefined) withSnapshots.push(record);
	}
	if (withSnapshots.size() > MAX_RETAINED_SNAPSHOTS) {
		withSnapshots.sort((a, b) => a.created_clock > b.created_clock);
		for (let i = MAX_RETAINED_SNAPSHOTS; i < withSnapshots.size(); i++) {
			const record = withSnapshots[i];
			if (record.status === "armed" || record.status === "triggered") continue;
			record.snapshot = undefined;
			captures.delete(record.capture_id);
		}
	}

	const remaining: string[] = [];
	for (const captureId of survivors) {
		if (captures.has(captureId)) remaining.push(captureId);
	}
	captureOrder = remaining;
}

function knownCaptureIds(): string[] {
	const known: string[] = [];
	for (const captureId of captureOrder) {
		if (captures.has(captureId)) known.push(captureId);
	}
	return known;
}

function captureNotFoundError(captureId: string): Record<string, unknown> {
	return {
		error: "micro_profiler_capture_not_found",
		message: `No MicroProfiler capture "${captureId}" on this peer. Captures are kept for ${RETAIN_CAPTURE_SECONDS} seconds and only the newest ${MAX_RETAINED_SNAPSHOTS} snapshots are retained.`,
		capture_id: captureId,
		known_capture_ids: knownCaptureIds(),
	};
}

function captureInProgressError(): Record<string, unknown> {
	for (const captureId of captureOrder) {
		const record = captures.get(captureId);
		if (record === undefined) continue;
		if (record.status !== "armed" && record.status !== "triggered") continue;
		return {
			error: "micro_profiler_capture_in_progress",
			message: `MicroProfiler capture ${captureId} is ${record.status} on this peer. Poll it with action="collect" or drop it with action="cancel".`,
			capture_id: captureId,
			status: record.status,
		};
	}
	return {
		error: "micro_profiler_capture_in_progress",
		message: "A MicroProfiler capture is already in progress; retry once it completes.",
	};
}

function analysisInProgressError(): Record<string, unknown> {
	return {
		error: "micro_profiler_analysis_in_progress",
		message: "Another MicroProfiler analysis is already running on this peer; retry once it completes.",
	};
}

// One live session serves every armed capture: it survives EnableCapture(false)/(true)
// cycles, so reopening it per capture would be pure waste.
function getLiveSession(LibMP: LibMPLike): LibMPSession | undefined {
	if (liveSession !== undefined) {
		const [ok, valid] = pcall(() => (liveSession as LibMPSession).IsValid());
		if (ok && valid === true) return liveSession;
		liveSession = undefined;
	}
	const [openOk, sessionOrErr] = pcall(() => LibMP.Session.OpenFromLiveData());
	if (!openOk || sessionOrErr === undefined) return undefined;
	const session = sessionOrErr as LibMPSession;
	const [validOk, valid] = pcall(() => session.IsValid());
	if (!validOk || valid !== true) return undefined;
	liveSession = session;
	return liveSession;
}

function invalidTriggerError(message: string): Record<string, unknown> {
	return {
		error: "micro_profiler_invalid_trigger",
		message,
	};
}

function normalizeTrigger(value: unknown): TriggerNormalizeResult {
	if (!typeIs(value, "table")) {
		return { error: invalidTriggerError("trigger must be an object with kind \"frame_time\", \"attribute\", or \"log\".") };
	}
	const raw = value as Record<string, unknown>;
	const kind = raw.kind;
	if (!typeIs(kind, "string")) {
		return { error: invalidTriggerError("trigger.kind must be one of \"frame_time\", \"attribute\", \"log\".") };
	}

	if (kind === "frame_time") {
		const threshold = raw.threshold_ms;
		if (!typeIs(threshold, "number") || threshold <= 0) {
			return { error: invalidTriggerError("trigger.threshold_ms must be a positive number of milliseconds.") };
		}
		return { trigger: { kind, threshold_ms: math.clamp(threshold, 1, 10000) } };
	}

	if (kind === "attribute") {
		const path = raw.instance;
		if (!typeIs(path, "string") || path === "") {
			return { error: invalidTriggerError("trigger.instance must be an instance path such as \"Workspace.SpikeFlag\".") };
		}
		const attributeName = raw.name;
		if (!typeIs(attributeName, "string") || attributeName === "") {
			return { error: invalidTriggerError("trigger.name must be a non-empty attribute name.") };
		}
		const instance = getInstanceByPath(path);
		if (instance === undefined) {
			return {
				error: {
					error: "micro_profiler_trigger_instance_not_found",
					message: `Could not resolve trigger instance path "${path}".`,
					instance: path,
				},
			};
		}
		const trigger: NormalizedTrigger = { kind, instance: path, name: attributeName };
		if (raw.value !== undefined) trigger.value = raw.value;
		return { trigger, instance };
	}

	if (kind === "log") {
		const substring = raw.substring;
		if (!typeIs(substring, "string") || substring === "") {
			return { error: invalidTriggerError("trigger.substring must be a non-empty string to match in LogService output.") };
		}
		return { trigger: { kind, substring } };
	}

	return { error: invalidTriggerError(`Unknown trigger kind "${kind}"; expected "frame_time", "attribute", or "log".`) };
}

function disconnectTriggerListeners(record: CaptureRecord): void {
	for (const connection of record.connections) {
		pcall(() => connection.Disconnect());
	}
	record.connections = [];
}

// Clears the capture guard on every terminal path (done, timed_out, cancelled, failed).
function finalizeCapture(record: CaptureRecord, status: string): void {
	record.status = status;
	record.finished_clock = os.clock();
	record.warming_up = false;
	captureInProgress = false;
	pruneCaptures();
}

// Attribute and log triggers cannot name a frame by themselves; the listener only records
// what it saw and the watcher turns that into a frame id at the next Heartbeat.
function connectTriggerListeners(record: CaptureRecord, triggerInstance: Instance | undefined): void {
	const trigger = record.trigger;
	if (trigger === undefined) return;

	if (trigger.kind === "attribute" && triggerInstance !== undefined) {
		const attributeName = trigger.name ?? "";
		const expected = trigger.value;
		record.connections.push(triggerInstance.GetAttributeChangedSignal(attributeName).Connect(() => {
			if (record.status !== "armed" || record.pending_external !== undefined) return;
			const current = triggerInstance.GetAttribute(attributeName);
			if (expected !== undefined) {
				if ((current as unknown) !== expected) return;
			} else if (current === undefined || current === false) {
				return;
			}
			record.pending_external = { attribute_value: current };
		}));
		return;
	}

	if (trigger.kind === "log") {
		const substring = trigger.substring ?? "";
		record.connections.push(LogService.MessageOut.Connect((message: string) => {
			if (record.status !== "armed" || record.pending_external !== undefined) return;
			if (string.find(message, substring, 1, true)[0] === undefined) return;
			record.pending_external = { matched_message: string.sub(message, 1, 200) };
		}));
	}
}

function markTriggered(record: CaptureRecord, kind: string, frame: FrameDescInfo | undefined, pending: PendingExternalTrigger | undefined): void {
	const triggerInfo: Record<string, unknown> = {
		kind,
		trigger_frame_id: frame !== undefined ? frame.frame_id : 0,
		trigger_frame_absolute_id: frame !== undefined ? frame.frame_absolute_id : 0,
		triggered_after_ms: round2((os.clock() - record.created_clock) * 1000),
	};
	if (frame !== undefined && frame.duration_valid) triggerInfo.trigger_frame_duration_us = frame.duration_us;
	if (frame !== undefined && frame.incomplete) triggerInfo.trigger_frame_incomplete = true;
	if (pending !== undefined) {
		if (pending.matched_message !== undefined) triggerInfo.matched_message = pending.matched_message;
		if (pending.attribute_value !== undefined) triggerInfo.attribute_value = pending.attribute_value;
	}
	record.trigger_info = triggerInfo;
	record.status = "triggered";
	disconnectTriggerListeners(record);
}

function armedWatcherBody(record: CaptureRecord, LibMP: LibMPLike, session: LibMPSession, triggerInstance: Instance | undefined): void {
	// Warmup frames are absorbed before trigger evaluation starts so the one-time engine
	// stall right after the profiler is enabled can never be mistaken for a spike.
	if (!captureWarmedUp) {
		record.warming_up = true;
		let absorbed = 0;
		for (let i = 0; i < WARMUP_FRAMES; i++) {
			if (record.cancel_requested) break;
			RunService.Heartbeat.Wait();
			absorbed += 1;
		}
		record.warmup_frames_absorbed = absorbed;
		record.warming_up = false;
		// A cancelled warmup has not pushed the stall frame out of the ring yet, so the next
		// capture has to absorb it again.
		if (absorbed === WARMUP_FRAMES) captureWarmedUp = true;
	}
	if (record.cancel_requested || record.status !== "armed") return;

	pcall(() => session.SyncWithDataSource());
	let lastSeen = session.GetFrameIdMax();
	connectTriggerListeners(record, triggerInstance);

	const trigger = record.trigger;
	const kind = trigger !== undefined ? trigger.kind : "frame_time";
	const thresholdMs = trigger !== undefined && trigger.threshold_ms !== undefined ? trigger.threshold_ms : 0;

	while (record.status === "armed") {
		RunService.Heartbeat.Wait();
		// cancel finalizes the record itself, so the watcher just steps out.
		if (record.cancel_requested) return;
		if (record.status !== "armed") break;

		if ((os.clock() - record.created_clock) * 1000 >= record.arm_timeout_ms) {
			disconnectTriggerListeners(record);
			pcall(() => LibMP.Control.EnableCapture(false));
			record.message = `No trigger within ${record.arm_timeout_ms} ms. Max observed frame ${record.observed.max_frame_us} us (frame ${record.observed.max_frame_id}, absolute ${record.observed.max_frame_absolute_id}). Re-arm with a lower threshold_ms or longer arm_timeout_ms.`;
			finalizeCapture(record, "timed_out");
			return;
		}

		const watcherStart = os.clock();
		// The C side syncs lazily; syncing explicitly each Heartbeat is the deterministic
		// choice and costs about 0.4 ms per frame either way.
		pcall(() => session.SyncWithDataSource());
		const [frameMaxOk, frameMaxValue] = pcall(() => session.GetFrameIdMax());
		const frameMax = frameMaxOk && typeIs(frameMaxValue, "number") ? frameMaxValue as number : lastSeen;
		// More than one new frame can appear between Heartbeats.
		for (let frameId = lastSeen + 1; frameId <= frameMax; frameId++) {
			const frame = readFrameDesc(session, frameId);
			if (frame === undefined) continue;
			if (frame.incomplete || frame.paused || !frame.duration_valid) continue;
			record.observed.frames_seen += 1;
			record.observed.total_frame_us += frame.duration_us;
			if (frame.duration_us > record.observed.max_frame_us) {
				record.observed.max_frame_us = frame.duration_us;
				record.observed.max_frame_id = frame.frame_id;
				record.observed.max_frame_absolute_id = frame.frame_absolute_id;
			}
			if (kind === "frame_time" && record.status === "armed" && frame.duration_us / 1000 >= thresholdMs) {
				markTriggered(record, kind, frame, undefined);
			}
		}
		if (frameMax > lastSeen) lastSeen = frameMax;
		record.observed.watcher_total_us += (os.clock() - watcherStart) * 1000000;
		record.observed.watcher_samples += 1;

		const pending = record.pending_external;
		if (pending !== undefined && record.status === "armed") {
			// The listener fired between Heartbeats, so the newest frame is the closest the
			// profiler can point at; the event's own work may land in that frame or the next.
			markTriggered(record, kind, readFrameDesc(session, lastSeen), pending);
			record.pending_external = undefined;
		}
	}

	if (record.status !== "triggered") return;

	// Let the aftermath of the spike land in the ring before snapshotting it.
	record.post_trigger_frames_remaining = record.post_trigger_frames;
	for (let i = 0; i < record.post_trigger_frames; i++) {
		if (record.cancel_requested) return;
		RunService.Heartbeat.Wait();
		record.post_trigger_frames_remaining = record.post_trigger_frames - (i + 1);
	}
	record.post_trigger_frames_remaining = 0;
	if (record.cancel_requested) return;

	const [snapshotOk, snapshotOrErr] = pcall(() => LibMP.Control.CaptureToBufferSync());
	// Capture is turned off after snapshotting exactly like the blocking path does; the
	// profiler itself stays enabled.
	pcall(() => LibMP.Control.EnableCapture(false));
	if (!snapshotOk || snapshotOrErr === undefined) {
		record.error_message = tostring(snapshotOrErr);
		finalizeCapture(record, "failed");
		return;
	}
	const snapshot = snapshotOrErr as buffer;
	record.snapshot = snapshot;
	record.snapshot_bytes = buffer.len(snapshot);
	finalizeCapture(record, "done");
}

function runArmedWatcher(record: CaptureRecord, LibMP: LibMPLike, session: LibMPSession, triggerInstance: Instance | undefined): void {
	const [ok, err] = pcall(() => armedWatcherBody(record, LibMP, session, triggerInstance));
	if (ok) return;
	record.error_message = tostring(err);
	disconnectTriggerListeners(record);
	// A record that cancel or the timeout path already finished has released the guard,
	// which may by now belong to a newer capture; only an unfinished record may finalize.
	if (isFinishedStatus(record.status)) return;
	pcall(() => LibMP.Control.EnableCapture(false));
	finalizeCapture(record, "failed");
}

function runArmCapture(requestData: Record<string, unknown>): unknown {
	if (!RunService.IsRunning()) {
		return {
			error: "runtime_target_required",
			message: "MicroProfiler capture requires a running playtest target such as target=\"server\" or target=\"client-1\".",
		};
	}

	pruneCaptures();

	const libOrError = requireLibMP();
	if ((libOrError as { Control?: unknown }).Control === undefined) return libOrError;
	const LibMP = libOrError as LibMPLike;

	const triggerResult = normalizeTrigger(requestData.trigger);
	if (triggerResult.error !== undefined) return triggerResult.error;
	const trigger = triggerResult.trigger as NormalizedTrigger;

	const armTimeoutMs = normalizeArmTimeoutMs(requestData.arm_timeout_ms);
	const postTriggerFrames = normalizePostTriggerFrames(requestData.post_trigger_frames, DEFAULT_POST_TRIGGER_FRAMES);
	let framesBefore = normalizeFramesBefore(requestData.frames_before, DEFAULT_FRAMES_BEFORE);
	const notes: string[] = [];
	if (framesBefore + postTriggerFrames > MAX_TRIGGER_WINDOW_FRAMES) {
		framesBefore = math.max(0, MAX_TRIGGER_WINDOW_FRAMES - postTriggerFrames);
		notes.push("frames_before reduced to fit the 256-frame ring");
	}
	const targetRole = normalizeTargetRole(requestData);

	const backendCheck = checkBackend(LibMP);
	if (backendCheck.error !== undefined) return backendCheck.error;
	const backend = backendCheck.backend;

	const [profilerOk, profilerResult] = safeCall(() => LibMP.Control.EnableProfiler(true));
	if (!profilerOk) {
		return {
			error: "micro_profiler_enable_failed",
			message: tostring(profilerResult),
			backend,
		};
	}

	const [captureStartOk, captureStartResult] = safeCall(() => LibMP.Control.EnableCapture(true));
	if (!captureStartOk) {
		return {
			error: "micro_profiler_capture_start_failed",
			message: tostring(captureStartResult),
			backend,
		};
	}

	const session = getLiveSession(LibMP);
	if (session === undefined) {
		pcall(() => LibMP.Control.EnableCapture(false));
		return {
			error: "micro_profiler_live_session_failed",
			message: "LibMP.Session.OpenFromLiveData() did not return a valid session in this peer.",
			backend,
		};
	}

	const record = createCaptureRecord("triggered", targetRole);
	record.trigger = trigger;
	record.arm_timeout_ms = armTimeoutMs;
	record.frames_before = framesBefore;
	record.post_trigger_frames = postTriggerFrames;
	registerCapture(record);

	// captureInProgress is already held by the dispatcher on behalf of this capture; the
	// watcher releases it through finalizeCapture on every terminal path.
	const triggerInstance = triggerResult.instance;
	task.spawn(() => runArmedWatcher(record, LibMP, session, triggerInstance));

	const response: Record<string, unknown> = {
		ok: true,
		action: "arm",
		capture_id: record.capture_id,
		status: "armed",
		target: targetRole,
		trigger,
		arm_timeout_ms: armTimeoutMs,
		frames_before: framesBefore,
		post_trigger_frames: postTriggerFrames,
		warmup_frames_pending: captureWarmedUp ? 0 : WARMUP_FRAMES,
		ring_frame_limit: RING_FRAME_LIMIT,
		backend,
		next: "Poll action=\"collect\" with this capture_id; status goes armed -> triggered -> done. Cancel with action=\"cancel\".",
	};
	if (notes.size() > 0) response.notes = notes;
	return response;
}

function buildCaptureBase(record: CaptureRecord, action: string): Record<string, unknown> {
	const finishedClock = record.finished_clock ?? os.clock();
	const observed: Record<string, unknown> = {
		frames_seen: record.observed.frames_seen,
		avg_frame_us: record.observed.frames_seen > 0 ? round2(record.observed.total_frame_us / record.observed.frames_seen) : 0,
		max_frame_us: record.observed.max_frame_us,
		max_frame_id: record.observed.max_frame_id,
		max_frame_absolute_id: record.observed.max_frame_absolute_id,
		watcher_avg_us: record.observed.watcher_samples > 0 ? round2(record.observed.watcher_total_us / record.observed.watcher_samples) : 0,
	};

	const base: Record<string, unknown> = {
		ok: true,
		action,
		capture_id: record.capture_id,
		status: record.status,
		target: record.target,
		kind: record.kind,
		created_at_ms: record.created_at_ms,
		elapsed_ms: math.floor((finishedClock - record.created_clock) * 1000 + 0.5),
		warmup_frames_absorbed: record.warmup_frames_absorbed,
		observed,
	};
	if (record.trigger !== undefined) {
		base.trigger = record.trigger;
		base.arm_timeout_ms = record.arm_timeout_ms;
		base.frames_before = record.frames_before;
		base.post_trigger_frames = record.post_trigger_frames;
	}
	if (record.warming_up) base.warming_up = true;
	if (record.trigger_info !== undefined) base.trigger_info = record.trigger_info;
	if (record.snapshot_bytes !== undefined) base.snapshot_bytes = record.snapshot_bytes;
	if (record.message !== undefined) base.message = record.message;
	if (record.error_message !== undefined) base.error_message = record.error_message;

	if (record.status === "armed") {
		base.remaining_ms = math.max(0, math.floor(record.arm_timeout_ms - (os.clock() - record.created_clock) * 1000 + 0.5));
		base.next = record.warming_up
			? "Absorbing first-capture warmup frames; poll action=\"collect\" again in a moment."
			: "Waiting for the trigger; poll action=\"collect\" again. Cancel with action=\"cancel\".";
	} else if (record.status === "triggered") {
		base.post_trigger_frames_remaining = record.post_trigger_frames_remaining ?? record.post_trigger_frames;
		base.next = "Trigger fired; poll action=\"collect\" again once the post-trigger frames have been captured.";
	}
	return base;
}

// Runs the analysis for a stored snapshot: collect on a finished capture, or analyze.
function analyzeStoredCapture(record: CaptureRecord, requestData: Record<string, unknown>, action: string): unknown {
	if (record.snapshot === undefined) {
		return {
			error: "micro_profiler_snapshot_evicted",
			message: `The snapshot for ${record.capture_id} is no longer retained (only the newest ${MAX_RETAINED_SNAPSHOTS} snapshots are kept).`,
			capture_id: record.capture_id,
			status: record.status,
		};
	}
	// An analysis walk yields and would read frames out from under a live capture, so it is
	// refused while any capture is armed, triggered, or running on this peer.
	if (captureInProgress) return captureInProgressError();
	if (analysisInProgress) return analysisInProgressError();

	const libOrError = requireLibMP();
	if ((libOrError as { Control?: unknown }).Control === undefined) return libOrError;
	const LibMP = libOrError as LibMPLike;
	const backend = checkBackend(LibMP).backend;

	let windowSpec: WindowSpec;
	if (record.kind === "triggered" && record.trigger_info !== undefined) {
		const info = record.trigger_info;
		const postTriggerFrames = normalizePostTriggerFrames(requestData.post_trigger_frames, record.post_trigger_frames);
		let framesBefore = normalizeFramesBefore(requestData.frames_before, record.frames_before);
		if (framesBefore + postTriggerFrames > MAX_TRIGGER_WINDOW_FRAMES) {
			framesBefore = math.max(0, MAX_TRIGGER_WINDOW_FRAMES - postTriggerFrames);
		}
		windowSpec = {
			mode: "trigger",
			trigger_frame_id: typeIs(info.trigger_frame_id, "number") ? info.trigger_frame_id as number : 0,
			trigger_frame_absolute_id: typeIs(info.trigger_frame_absolute_id, "number") ? info.trigger_frame_absolute_id as number : undefined,
			frames_before: framesBefore,
			post_trigger_frames: postTriggerFrames,
		};
	} else {
		const frameWindow = typeIs(requestData.frame_window, "number")
			? normalizeFrameWindow(requestData.frame_window)
			: record.frame_window ?? DEFAULT_FRAME_WINDOW;
		windowSpec = { mode: "tail", frame_window: frameWindow };
	}

	const settings = buildAnalysisSettings(requestData);
	const snapshot = record.snapshot;
	analysisInProgress = true;
	const [ok, analysisResult] = pcall(() =>
		analyzeSnapshot(LibMP, snapshot, settings, windowSpec, {
			warmupFramesAbsorbed: record.warmup_frames_absorbed,
			durationMs: record.duration_ms,
			backend,
		}),
	);
	analysisInProgress = false;
	if (!ok) {
		return {
			error: `micro_profiler_${action}_failed`,
			message: tostring(analysisResult),
			capture_id: record.capture_id,
		};
	}

	const base = buildCaptureBase(record, action);
	// Analysis fields win for shared keys; the record still owns action/capture_id/status.
	for (const [key, value] of pairs(analysisResult as Record<string, unknown>)) {
		base[key as string] = value;
	}
	base.action = action;
	base.capture_id = record.capture_id;
	base.status = record.status;
	return base;
}

function runCollectCapture(requestData: Record<string, unknown>): unknown {
	pruneCaptures();
	const captureId = requestData.capture_id;
	if (!typeIs(captureId, "string") || captureId === "") {
		return {
			error: "micro_profiler_capture_id_required",
			message: "action=\"collect\" needs the capture_id returned by action=\"arm\" or action=\"capture\".",
		};
	}
	const record = captures.get(captureId);
	if (record === undefined) return captureNotFoundError(captureId);

	if (record.status === "done") return analyzeStoredCapture(record, requestData, "collect");
	return buildCaptureBase(record, "collect");
}

function runCancelCapture(requestData: Record<string, unknown>): unknown {
	const captureId = requestData.capture_id;
	if (!typeIs(captureId, "string") || captureId === "") {
		return {
			error: "micro_profiler_capture_id_required",
			message: "action=\"cancel\" needs the capture_id returned by action=\"arm\" or action=\"capture\".",
		};
	}
	const record = captures.get(captureId);
	if (record === undefined) return captureNotFoundError(captureId);

	const previousStatus = record.status;
	let discardedSnapshot = false;
	if (previousStatus === "armed" || previousStatus === "triggered") {
		disconnectTriggerListeners(record);
		record.cancel_requested = true;
		const libOrError = requireLibMP();
		if ((libOrError as { Control?: unknown }).Control !== undefined) {
			const LibMP = libOrError as LibMPLike;
			pcall(() => LibMP.Control.EnableCapture(false));
		}
		finalizeCapture(record, "cancelled");
	} else if (record.snapshot !== undefined) {
		record.snapshot = undefined;
		discardedSnapshot = true;
		record.status = "cancelled";
		if (record.finished_clock === undefined) record.finished_clock = os.clock();
		pruneCaptures();
	}

	const response: Record<string, unknown> = {
		ok: true,
		action: "cancel",
		capture_id: record.capture_id,
		status: record.status,
		previous_status: previousStatus,
		target: record.target,
		kind: record.kind,
	};
	if (discardedSnapshot) response.discarded_snapshot = true;
	return response;
}

function runAnalyzeCapture(requestData: Record<string, unknown>): unknown {
	pruneCaptures();
	const captureId = requestData.capture_id;
	if (!typeIs(captureId, "string") || captureId === "") {
		return {
			error: "micro_profiler_capture_id_required",
			message: "action=\"analyze\" needs the capture_id of a finished capture.",
		};
	}
	const record = captures.get(captureId);
	if (record === undefined) return captureNotFoundError(captureId);
	if (record.status !== "done") {
		return {
			error: "micro_profiler_capture_not_ready",
			message: `Capture ${captureId} is ${record.status}; only a finished capture holding a snapshot can be re-analyzed.`,
			capture_id: captureId,
			status: record.status,
		};
	}
	return analyzeStoredCapture(record, requestData, "analyze");
}

function runMicroProfilerCapture(requestData: Record<string, unknown>): unknown {
	if (!RunService.IsRunning()) {
		return {
			error: "runtime_target_required",
			message: "MicroProfiler capture requires a running playtest target such as target=\"server\" or target=\"client-1\".",
		};
	}

	const libOrError = requireLibMP();
	if ((libOrError as { Control?: unknown }).Control === undefined) return libOrError;
	const LibMP = libOrError as LibMPLike;

	const durationMs = normalizeDurationMs(requestData.duration_ms);
	const frameWindow = normalizeFrameWindow(requestData.frame_window);
	const targetRole = normalizeTargetRole(requestData);

	const backendCheck = checkBackend(LibMP);
	const backend = backendCheck.backend;
	if (backendCheck.error !== undefined) return backendCheck.error;

	const [profilerOk, profilerResult] = safeCall(() => LibMP.Control.EnableProfiler(true));
	if (!profilerOk) {
		return {
			error: "micro_profiler_enable_failed",
			message: tostring(profilerResult),
			backend,
		};
	}

	const [captureStartOk, captureStartResult] = safeCall(() => LibMP.Control.EnableCapture(true));
	if (!captureStartOk) {
		return {
			error: "micro_profiler_capture_start_failed",
			message: tostring(captureStartResult),
			backend,
		};
	}

	// First-capture warmup: the first capture after the profiler is enabled carries a
	// one-time ~350ms engine stall ~12 frames in (IsPaused=false, so heuristics miss it).
	// Absorb extra Heartbeat frames before the real capture window opens so the stall
	// frame is evicted from the rolling buffer and never lands in the analyzed window.
	let warmupFramesAbsorbed = 0;
	if (!captureWarmedUp) {
		for (let i = 0; i < WARMUP_FRAMES; i++) {
			RunService.Heartbeat.Wait();
		}
		captureWarmedUp = true;
		warmupFramesAbsorbed = WARMUP_FRAMES;
	}

	task.wait(durationMs / 1000);

	const [captureStopOk, captureStopResult] = safeCall(() => LibMP.Control.EnableCapture(false));
	if (!captureStopOk) {
		return {
			error: "micro_profiler_capture_stop_failed",
			message: tostring(captureStopResult),
			backend,
		};
	}

	const [bufferOk, snapshotOrErr] = safeCall(() => LibMP.Control.CaptureToBufferSync());
	if (!bufferOk) {
		return {
			error: "micro_profiler_snapshot_failed",
			message: tostring(snapshotOrErr),
			backend,
		};
	}
	const snapshot = snapshotOrErr as buffer;

	const record = createCaptureRecord("blocking", targetRole);
	record.duration_ms = durationMs;
	record.frame_window = frameWindow;
	record.snapshot = snapshot;
	record.snapshot_bytes = buffer.len(snapshot);
	record.warmup_frames_absorbed = warmupFramesAbsorbed;
	record.status = "done";
	record.finished_clock = os.clock();
	registerCapture(record);

	if (analysisInProgress) {
		return {
			error: "micro_profiler_analysis_in_progress",
			message: "Another MicroProfiler analysis is already running on this peer; retry once it completes.",
			capture_id: record.capture_id,
			backend,
		};
	}

	// The walk yields cooperatively, so the flag is cleared on both pcall result paths.
	analysisInProgress = true;
	const [analysisOk, analysisResult] = pcall(() =>
		analyzeSnapshot(LibMP, snapshot, buildAnalysisSettings(requestData), { mode: "tail", frame_window: frameWindow }, {
			warmupFramesAbsorbed,
			durationMs,
			backend,
		}),
	);
	analysisInProgress = false;
	pruneCaptures();
	if (!analysisOk) {
		return {
			error: "micro_profiler_capture_failed",
			message: tostring(analysisResult),
			capture_id: record.capture_id,
			backend,
		};
	}

	const result = analysisResult as Record<string, unknown>;
	result.action = "capture";
	result.capture_id = record.capture_id;
	result.status = "done";
	return result;
}

// Action dispatch. The blocking capture and the armed watcher both hold
// captureInProgress; every terminal path clears it (finalizeCapture for armed captures,
// both pcall result paths here for the blocking one), so a thrown error cannot wedge it.
// The validation guards inside the workers do not yield before the flag is set, so no
// concurrent caller can observe a stale flag during a cheap early return.
function captureMicroProfiler(requestData: Record<string, unknown>): unknown {
	let action = "capture";
	const requestedAction = requestData.action;
	if (requestedAction !== undefined) {
		if (!typeIs(requestedAction, "string") || !VALID_ACTIONS.includes(requestedAction)) {
			return {
				error: "micro_profiler_invalid_action",
				message: `Unknown action "${tostring(requestedAction)}" for capture_micro_profiler.`,
				valid_actions: VALID_ACTIONS,
			};
		}
		action = requestedAction;
	}

	if (action === "arm") {
		if (captureInProgress) return captureInProgressError();
		// An analysis walk burns up to its whole per-frame budget on this peer; arming under
		// it would hand the watcher polluted frame times.
		if (analysisInProgress) return analysisInProgressError();
		// The dispatcher owns the guard: it is taken before any setup runs and released
		// unless a watcher actually started, so an error thrown mid-setup can neither leave
		// it wedged on nor release a guard that belongs to another capture.
		captureInProgress = true;
		const [ok, result] = pcall(() => runArmCapture(requestData));
		const armed = ok && typeIs(result, "table") && (result as Record<string, unknown>).status === "armed";
		if (!armed) captureInProgress = false;
		if (!ok) {
			return {
				error: "micro_profiler_arm_failed",
				message: tostring(result),
			};
		}
		return result;
	}

	if (action === "collect" || action === "analyze") {
		const [ok, result] = pcall(() => action === "collect" ? runCollectCapture(requestData) : runAnalyzeCapture(requestData));
		if (!ok) {
			return {
				error: `micro_profiler_${action}_failed`,
				message: tostring(result),
			};
		}
		return result;
	}

	if (action === "cancel") {
		const [ok, result] = pcall(() => runCancelCapture(requestData));
		if (!ok) {
			return {
				error: "micro_profiler_cancel_failed",
				message: tostring(result),
			};
		}
		return result;
	}

	if (captureInProgress) return captureInProgressError();
	// Same reasoning as for arm: a concurrent analysis walk would pollute the capture window.
	if (analysisInProgress) return analysisInProgressError();

	captureInProgress = true;
	const [ok, result] = pcall(() => runMicroProfilerCapture(requestData));
	captureInProgress = false;
	if (!ok) {
		return {
			error: "micro_profiler_capture_failed",
			message: tostring(result),
		};
	}
	return result;
}

export = { captureMicroProfiler };
