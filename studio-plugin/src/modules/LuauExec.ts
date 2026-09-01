/* eslint-disable */
// Shared execute_luau machinery for edit/server (MetadataHandlers.executeLuau),
// the play-client peer (ClientBroker.handleExecuteLuau), and the game-VM eval
// bridges (EvalRuntimeHandlers). Three things this module owns:
//
//   1. The IIFE wrapper that captures print/warn, wraps require() so nested
//      ModuleScript load failures can recover the real LogService diagnostic,
//      runs user code in xpcall, and always returns { ok, value, output } so
//      the ModuleScript itself always returns exactly one value (otherwise
//      `print("hi")` with no return would fail with "Module code did not
//      return exactly one value"). With { serializeReturn: true } (the
//      eval_*_runtime path) the wrapper also formats the return value inside
//      the game VM, because that result then crosses a BindableFunction
//      boundary which rejects cyclic tables ("tables cannot be cyclic") and
//      silently drops the string keys of mixed tables. Without it a plain
//      `return require(SomeModule)` could fail at the bridge while the same
//      require wrapped in pcall appeared to work.
//
//   2. The loadstring-then-ModuleScript-require fallback, with the parse-error
//      recovery that pulls the real diagnostic from LogService. Recovery only
//      reads entries written after the require started, so a stale payload
//      error from an earlier run is never blamed on the current one.
//
//   3. Return-value formatting: tables get HttpService:JSONEncode'd so the
//      caller sees `{"x":1,"y":2}` instead of `table: 0xaddr`; primitives
//      pass through tostring. The encode is pcall'd so cycles or
//      non-serializable values gracefully fall back to tostring.
//
// Require diagnostics. Roblox collapses a failing require() into the canned
// "Requested module experienced an error while loading" string, logs the real
// diagnostic to LogService instead, and caches the failure, so later requires
// of the same module log nothing new. The wrapper's require() recovers the
// message in this order: (a) an error logged while this require ran that names
// the module, (b) the module's earlier logged error, annotated as such, (c) any
// other error logged while this require ran, annotated because it may belong
// to another script, (d) the canned string. In a solo playtest every DataModel
// has its own LogService history, but other scripts in the same DataModel can
// still log during the recovery window, which is why (c) is annotated and
// ranked last.
//
// Before this module existed, the client peer used a stripped-down
// require-only execution path that lacked both the wrapper and the JSON
// formatting, producing two well-known papercuts:
//   - `print("hi")` (no return) failed with "Module code did not return..."
//   - Returning a table yielded `table: 0xaddr` instead of structured data.

const HttpService = game.GetService("HttpService");
const LogService = game.GetService("LogService");

interface WrapperResult {
	ok?: boolean;
	value?: unknown;
	output?: defined;
}

interface ExecuteResult {
	success: boolean;
	returnValue?: string;
	output?: string[];
	error?: string;
	message?: string;
}

interface LogHistoryEntry {
	message: string;
	messageType: Enum.MessageType;
	timestamp: number;
}

interface WrapperOptions {
	// Format the return value inside the executing VM (JSON for tables,
	// tostring otherwise) so it survives a BindableFunction boundary.
	serializeReturn?: boolean;
}

const PAYLOAD_INSTANCE_NAME = "__MCPExecLuauPayload";
const REQUIRE_GENERIC_ERROR = "Requested module experienced an error while loading";

// The real parse diagnostic for a payload lands in LogService on a later
// engine frame than the require() failure; poll briefly for it.
const RECOVERY_POLLS = 5;
const RECOVERY_POLL_SEC = 0.05;

// Count source lines so the wrapper can filter traceback frames that fall
// outside the user code range (the wrapper's own preamble/postamble lines).
function countLines(s: string): number {
	let n = 1;
	const size = s.size();
	for (let i = 1; i <= size; i++) {
		if (string.sub(s, i, i) === "\n") n++;
	}
	return n;
}

function luaPatternEscape(s: string): string {
	const [escaped] = string.gsub(s, "([^%w])", "%%%1");
	return escaped;
}

function logHistory(): LogHistoryEntry[] {
	const [ok, hist] = pcall(() => LogService.GetLogHistory());
	if (ok && typeIs(hist, "table")) return hist as unknown as LogHistoryEntry[];
	return [];
}

function logHistoryLength(): number {
	return logHistory().size();
}

// Everything the wrapper emits BEFORE the first line of user code. Kept as its
// own function so WRAPPER_LINE_OFFSET can be derived from it instead of being
// maintained by hand (a stale hand-kept offset shifts every reported line).
function wrapperPrefix(lineOffset: number, userLines: number): string {
	return `return ((function()
\tlocal __mcp_traceback
\tlocal __mcp_remap
\tlocal __mcp_LINE_OFFSET = ${lineOffset}
\tlocal __mcp_USER_LINES = ${userLines}
\tlocal __mcp_LogService = game:GetService("LogService")
\tlocal __mcp_REQUIRE_GENERIC = "${REQUIRE_GENERIC_ERROR}"
\tlocal __mcp_output = {}
\tlocal __mcp_real_print = print
\tlocal __mcp_real_warn = warn
\tlocal __mcp_real_require = require
\tlocal print = function(...)
\t\t__mcp_real_print(...)
\t\tlocal args = {...}
\t\tlocal parts = table.create(#args)
\t\tfor i, a in ipairs(args) do parts[i] = tostring(a) end
\t\ttable.insert(__mcp_output, table.concat(parts, "\\t"))
\tend
\tlocal warn = function(...)
\t\t__mcp_real_warn(...)
\t\tlocal args = {...}
\t\tlocal parts = table.create(#args)
\t\tfor i, a in ipairs(args) do parts[i] = tostring(a) end
\t\ttable.insert(__mcp_output, "[warn] " .. table.concat(parts, "\\t"))
\tend
\t-- Reading the log history must never break a require that would have
\t-- worked, so failures here degrade to "no history" instead of erroring.
\tlocal function __mcp_log_history()
\t\tlocal ok, hist = pcall(function() return __mcp_LogService:GetLogHistory() end)
\t\tif ok and typeof(hist) == "table" then return hist end
\t\treturn {}
\tend
\tlocal function __mcp_is_stack_noise(msg)
\t\treturn msg == "Stack Begin" or msg == "Stack End" or string.sub(msg, 1, 8) == "Script '"
\tend
\tlocal function __mcp_is_actionable_require_log(entry)
\t\tif not entry or entry.messageType ~= Enum.MessageType.MessageError then return false end
\t\tlocal msg = tostring(entry.message)
\t\treturn msg ~= __mcp_REQUIRE_GENERIC and not __mcp_is_stack_noise(msg)
\tend
\tlocal function __mcp_entry_mentions_module(entry, module_path)
\t\tif not entry or not module_path or module_path == "" then return false end
\t\treturn string.find(tostring(entry.message), module_path, 1, true) ~= nil
\tend
\tlocal function __mcp_module_key(module)
\t\tif typeof(module) == "Instance" then
\t\t\tlocal ok_path, path = pcall(function() return module:GetFullName() end)
\t\t\tif ok_path then return path end
\t\t\treturn nil
\t\tend
\t\tif typeof(module) == "string" then
\t\t\t-- require-by-string: "@game/ReplicatedStorage/Foo" names the same
\t\t\t-- instance as "ReplicatedStorage.Foo"; a relative path only gives the
\t\t\t-- module name, which is the best key available.
\t\t\tif string.sub(module, 1, 6) == "@game/" then
\t\t\t\treturn (string.gsub(string.sub(module, 7), "/", "."))
\t\t\tend
\t\t\treturn string.match(module, "([^/]+)$")
\t\tend
\t\treturn nil
\tend
\t-- Latest error in hist[from..to] that names the module: the entry itself
\t-- when it is actionable, else the actionable error logged just before the
\t-- module's stack line ("Script 'Path', Line N").
\tlocal function __mcp_module_error_in(hist, module_path, from, to)
\t\tif not module_path or module_path == "" then return nil end
\t\tfor i = to, math.max(1, from), -1 do
\t\t\tlocal entry = hist[i]
\t\t\tif __mcp_entry_mentions_module(entry, module_path) then
\t\t\t\tif __mcp_is_actionable_require_log(entry) then
\t\t\t\t\treturn tostring(entry.message)
\t\t\t\tend
\t\t\t\tfor j = i - 1, math.max(from, i - 6), -1 do
\t\t\t\t\tlocal previous = hist[j]
\t\t\t\t\tif __mcp_is_actionable_require_log(previous) then
\t\t\t\t\t\treturn tostring(previous.message)
\t\t\t\t\tend
\t\t\t\tend
\t\t\tend
\t\tend
\t\treturn nil
\tend
\tlocal function __mcp_recover_require_error(err, history_start, module)
\t\tlocal err_msg = tostring(err)
\t\tif err_msg ~= __mcp_REQUIRE_GENERIC then return err_msg end
\t\tlocal module_path = __mcp_module_key(module)
\t\ttask.wait(0.05)
\t\tlocal hist = __mcp_log_history()
\t\t-- (a) the diagnostic this require just produced
\t\tlocal fresh = __mcp_module_error_in(hist, module_path, history_start + 1, #hist)
\t\tif fresh then return fresh end
\t\t-- (b) Roblox caches a failed load, so the diagnostic may predate this require
\t\tlocal earlier = __mcp_module_error_in(hist, module_path, 1, history_start)
\t\tif earlier then
\t\t\treturn earlier .. " (recovered from an earlier Output error for " .. module_path .. "; Roblox caches a failed module load, so this require repeated that failure)"
\t\tend
\t\t-- (c) something else errored while this require ran; report it, but say so
\t\tfor i = #hist, history_start + 1, -1 do
\t\t\tlocal entry = hist[i]
\t\t\tif __mcp_is_actionable_require_log(entry) then
\t\t\t\treturn tostring(entry.message) .. " (Output error logged while requiring " .. tostring(module_path or module) .. "; it may belong to another script)"
\t\t\tend
\t\tend
\t\treturn err_msg
\tend
\tlocal function require(module)
\t\tlocal history_start = #__mcp_log_history()
\t\tlocal ok, value = pcall(__mcp_real_require, module)
\t\tif ok then return value end
\t\terror(__mcp_recover_require_error(value, history_start, module), 0)
\tend
\tlocal function __mcp_run()
`;
}

// Number of lines the wrapper emits BEFORE the first line of user code. Used
// both inside the wrapper (Luau __mcp_LINE_OFFSET) and on the TS side
// (remapPayloadLines, for compile errors recovered from LogService) so user
// code errors report user-relative line numbers instead of the inflated
// payload line the wrapper would otherwise expose. Derived from the prefix
// text, so reordering the preamble cannot desynchronize it. The prefix ends
// with a newline, so the user code starts on line countLines(prefix).
const WRAPPER_LINE_OFFSET = countLines(wrapperPrefix(0, 0)) - 1;

function wrapperPostamble(payloadPattern: string, serializeReturn: boolean): string {
	return `
\tend
\t__mcp_remap = function(s)
\t\t-- Two chunk-name formats can reference our payload:
\t\t--   * "Workspace.__MCPExecLuauPayload:N" — ModuleScript:require fallback path
\t\t--   * "[string \\"return ((function()...\\"]:N" — loadstring() (default in plugin)
\t\t-- Subtract LINE_OFFSET to get the user-relative number, then clamp.
\t\t-- Clamping matters for unclosed constructs ("local x = (") where the
\t\t-- parser keeps reading into wrapper postamble and reports a payload
\t\t-- line past user EOF. Without clamping, that frames wrapper postamble
\t\t-- as user code.
\t\tlocal function __mcp_user_line(payload_n)
\t\t\tlocal user_n = payload_n - __mcp_LINE_OFFSET
\t\t\tif user_n < 1 then return "1" end
\t\t\tif user_n > __mcp_USER_LINES then return tostring(__mcp_USER_LINES) .. " (at end of input)" end
\t\t\treturn tostring(user_n)
\t\tend
\t\ts = string.gsub(s, "Workspace%.${payloadPattern}:(%d+)", function(num)
\t\t\tlocal n = tonumber(num)
\t\t\tif n then return "user_code:" .. __mcp_user_line(n) end
\t\t\treturn "user_code:" .. num
\t\tend)
\t\ts = string.gsub(s, "${payloadPattern}:(%d+)", function(num)
\t\t\tlocal n = tonumber(num)
\t\t\tif n then return "user_code:" .. __mcp_user_line(n) end
\t\t\treturn "user_code:" .. num
\t\tend)
\t\ts = string.gsub(s, '%[string "[^"]+"%]:(%d+)', function(num)
\t\t\tlocal n = tonumber(num)
\t\t\tif n then return "user_code:" .. __mcp_user_line(n) end
\t\t\treturn "user_code:" .. num
\t\tend)
\t\treturn s
\tend
\t__mcp_traceback = function(err)
\t\tlocal raw = debug.traceback(tostring(err), 2)
\t\tlocal kept = {}
\t\tfor line in string.gmatch(raw, "[^\\n]+") do
\t\t\t-- Extract referenced line number (either chunk-name format).
\t\t\tlocal num_str = string.match(line, "${payloadPattern}:(%d+)")
\t\t\t\tor string.match(line, '%[string "[^"]+"%]:(%d+)')
\t\t\tlocal n = num_str and tonumber(num_str)
\t\t\t-- Strip the "in function '__mcp_run'" annotation before doing
\t\t\t-- any filtering, because user-code frames carry that suffix —
\t\t\t-- the entire user payload is hosted inside __mcp_run, so EVERY
\t\t\t-- user frame would otherwise match a naive "__mcp_" filter and
\t\t\t-- get dropped. Strip first, then apply filters.
\t\t\tline = (string.gsub(line, " in function '__mcp_run'", ""))
\t\t\tlocal skip = string.find(line, "MCPPlugin", 1, true)
\t\t\t\tor string.find(line, "__mcp_", 1, true)
\t\t\t\tor string.find(line, "in function 'xpcall'", 1, true)
\t\t\t-- Frame lines pointing at wrapper preamble/postamble (outside
\t\t\t-- user range) are wrapper internals — drop them. Lines without
\t\t\t-- a payload-chunk line number (the traceback header / engine
\t\t\t-- C frames) are kept; remap is a no-op for them.
\t\t\tif n and (n <= __mcp_LINE_OFFSET or n > __mcp_LINE_OFFSET + __mcp_USER_LINES) then
\t\t\t\tskip = true
\t\t\tend
\t\t\tif not skip then
\t\t\t\ttable.insert(kept, __mcp_remap(line))
\t\t\tend
\t\tend
\t\treturn table.concat(kept, "\\n")
\tend
\t-- With serializeReturn the value is formatted here, inside the executing
\t-- VM, because the result may cross a BindableFunction boundary that
\t-- rejects cyclic tables and drops the string keys of mixed tables.
\tlocal __mcp_SERIALIZE_RETURN = ${serializeReturn ? "true" : "false"}
\tlocal function __mcp_format_value(v)
\t\tif typeof(v) == "table" then
\t\t\tlocal ok_json, encoded = pcall(function()
\t\t\t\treturn game:GetService("HttpService"):JSONEncode(v)
\t\t\tend)
\t\t\tif ok_json then return encoded end
\t\tend
\t\treturn tostring(v)
\tend
\tlocal ok, errOrValue = xpcall(__mcp_run, __mcp_traceback)
\tif ok and __mcp_SERIALIZE_RETURN and errOrValue ~= nil then
\t\terrOrValue = __mcp_format_value(errOrValue)
\tend
\treturn { ok = ok, value = errOrValue, output = __mcp_output }
end)())`;
}

function buildWrapper(code: string, payloadInstanceName = PAYLOAD_INSTANCE_NAME, options: WrapperOptions = {}): string {
	const userLines = countLines(code);
	const payloadPattern = luaPatternEscape(payloadInstanceName);
	return wrapperPrefix(WRAPPER_LINE_OFFSET, userLines) + code + wrapperPostamble(payloadPattern, options.serializeReturn === true);
}

// TS-side mirror of the Lua __mcp_remap. Used by runViaModuleScript when
// pulling the real compile-error diagnostic out of LogService — that error
// references the payload module's line number directly, and never passes
// through the IIFE's runtime wrapper.
function remapPayloadLines(s: string, userLines: number, payloadInstanceName = PAYLOAD_INSTANCE_NAME): string {
	// Mirror of the Lua __mcp_remap inside the wrapper, for paths that
	// don't pass through the IIFE (compile errors recovered from
	// LogService, the immediate loadstring compileError surface). Same
	// two-format coverage plus the same clamp: unclosed user constructs
	// let the parser consume wrapper postamble, so the raw payload line
	// is sometimes well past user EOF — clamp to [1, userLines] and
	// annotate so the error doesn't say "user_code:49" for one-line input.
	const userLine = (payload: number): string => {
		const u = payload - WRAPPER_LINE_OFFSET;
		if (u < 1) return "1";
		if (u > userLines) return `${tostring(userLines)} (at end of input)`;
		return tostring(u);
	};
	const payloadPattern = luaPatternEscape(payloadInstanceName);
	let out = s;
	const [a] = string.gsub(out, `Workspace%.${payloadPattern}:(%d+)`, (num: string) => {
		const n = tonumber(num);
		if (n !== undefined) return `user_code:${userLine(n)}`;
		return `user_code:${num}`;
	});
	out = a;
	const [b] = string.gsub(out, `${payloadPattern}:(%d+)`, (num: string) => {
		const n = tonumber(num);
		if (n !== undefined) return `user_code:${userLine(n)}`;
		return `user_code:${num}`;
	});
	out = b;
	const [c] = string.gsub(out, '%[string "[^"]+"%]:(%d+)', (num: string) => {
		const n = tonumber(num);
		if (n !== undefined) return `user_code:${userLine(n)}`;
		return `user_code:${num}`;
	});
	return c;
}

function runViaModuleScript(wrapped: string, userLines: number): WrapperResult {
	const m = new Instance("ModuleScript");
	m.Name = PAYLOAD_INSTANCE_NAME;
	const [okSet, setErr] = pcall(() => {
		(m as unknown as { Source: string }).Source = wrapped;
	});
	if (!okSet) {
		m.Destroy();
		// error(..., 0) suppresses the "user_MCPPlugin.rbxmx.MCPPlugin.modules.LuauExec:N:"
		// prefix that error() would otherwise prepend, keeping the visible
		// message focused on the user-actionable error rather than our path.
		error(`ModuleScript Source set failed: ${tostring(setErr)}`, 0);
	}
	m.Parent = game.GetService("Workspace");
	// Snapshot the log length first so recovery only reads diagnostics written
	// by this require, never a stale payload error left by an earlier run.
	const historyStart = logHistoryLength();
	const [okReq, reqResult] = pcall(() => require(m));
	m.Destroy();
	if (!okReq) {
		// Compile errors reference the payload module's line number directly
		// — remap + clamp to user-relative line numbers so `local x = 1 +`
		// reports :1: instead of :23:, and reports the clamp annotation
		// when the parser ran off the end of user code into wrapper code.
		error(recoverPayloadRequireError(reqResult, userLines, PAYLOAD_INSTANCE_NAME, historyStart), 0);
	}
	return reqResult as unknown as WrapperResult;
}

function isLoadstringUnavailable(err: unknown): boolean {
	const errStr = tostring(err);
	const [matchStart] = string.find(errStr, "not available", 1, true);
	return matchStart !== undefined;
}

// Returns a string suitable for `returnValue`. Tables get JSON-encoded so
// the caller sees structured data instead of "table: 0xaddr". Anything that
// JSONEncode chokes on (cycles, Roblox userdata) falls back to tostring.
// Values already formatted inside the wrapper (serializeReturn) are strings
// and pass through unchanged.
function formatReturnValue(value: unknown): string {
	if (value === undefined) return "";
	if (typeIs(value, "table")) {
		const [ok, encoded] = pcall(() => HttpService.JSONEncode(value));
		if (ok) return encoded as string;
	}
	return tostring(value);
}

function recoverPayloadRequireError(
	err: unknown,
	userLines: number,
	payloadInstanceName = PAYLOAD_INSTANCE_NAME,
	historyStart = 0,
): string {
	let errMsg = tostring(err);
	// pcall(require, m) collapses parse/compile failures into the canned
	// engine string. The real diagnostic is emitted to LogService on a later
	// engine frame; poll briefly, scanning only entries written after
	// historyStart so an earlier run's payload error is never picked up.
	if (errMsg === REQUIRE_GENERIC_ERROR) {
		const payloadPathPrefix = `Workspace.${payloadInstanceName}:`;
		const start = math.max(0, historyStart);
		for (let attempt = 0; attempt < RECOVERY_POLLS; attempt++) {
			task.wait(RECOVERY_POLL_SEC);
			const hist = logHistory();
			let found: string | undefined;
			for (let i = hist.size() - 1; i >= start; i--) {
				const e = hist[i];
				if (
					e.messageType === Enum.MessageType.MessageError &&
					string.sub(e.message, 1, payloadPathPrefix.size()) === payloadPathPrefix
				) {
					found = e.message;
					break;
				}
			}
			if (found !== undefined) {
				errMsg = found;
				break;
			}
		}
	}
	return remapPayloadLines(errMsg, userLines, payloadInstanceName);
}

function execute(code: string): ExecuteResult {
	if (!code || code === "") {
		return { success: false, error: "code is required" };
	}
	const wrapped = buildWrapper(code);
	const userLines = countLines(code);

	let [success, result] = pcall(() => {
		const [fn, compileError] = loadstring(wrapped);
		if (!fn) {
			if (isLoadstringUnavailable(compileError)) {
				return runViaModuleScript(wrapped, userLines);
			}
			error(`Compile error: ${remapPayloadLines(tostring(compileError), userLines)}`, 0);
		}
		return fn() as unknown as WrapperResult;
	});

	// loadstring can throw (not return nil) when ServerScriptService.
	// LoadStringEnabled is false; treat that as a second-chance fallback.
	if (!success && isLoadstringUnavailable(result)) {
		[success, result] = pcall(() => runViaModuleScript(wrapped, userLines));
	}

	if (!success) {
		return {
			success: false,
			error: tostring(result),
			output: [],
			message: "Code execution failed",
		};
	}

	const r = result as unknown as WrapperResult;
	const capturedOutput = r.output as unknown as string[] | undefined;
	const output = capturedOutput !== undefined ? capturedOutput : ([] as string[]);
	if (r.ok === true) {
		return {
			success: true,
			returnValue: r.value !== undefined ? formatReturnValue(r.value) : undefined,
			output,
			message: "Code executed successfully",
		};
	}
	return {
		success: false,
		error: r.value !== undefined ? tostring(r.value) : "(unknown error)",
		output,
		message: "Code execution failed",
	};
}

export = {
	buildWrapper,
	countLines,
	execute,
	formatReturnValue,
	recoverPayloadRequireError,
	remapPayloadLines,
};
