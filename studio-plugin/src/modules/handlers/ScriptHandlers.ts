import Utils from "../Utils";
import Recording from "../Recording";

const ScriptEditorService = game.GetService("ScriptEditorService");

const { getInstancePath, getInstanceByPath, readScriptSource, splitLines, joinLines } = Utils;
const { beginRecording, finishRecording } = Recording;

const SOURCE_TRUNCATE_CHAR_BUDGET = 25000;
const SOURCE_TRUNCATE_LINE_BUDGET = 400;
const SOURCE_TRUNCATE_TO_LINES = 300;

// NOTE: Script text arrives here already fully decoded. The request body is transported as JSON and
// HttpService.JSONDecode (Communication.ts) resolves every JSON string escape exactly once. Any further
// escape processing here would DOUBLE-decode the content and corrupt literal backslash sequences the
// model legitimately wants to keep in the Lua source (e.g. `"\n"`, `"\t"`, Windows paths like `"C:\\Users"`).
// Therefore the handlers below write requestData.source / old_string / new_string / newContent verbatim.

function getTopServiceName(instance: Instance): string {
	let topServiceInst: Instance = instance;
	while (topServiceInst.Parent && topServiceInst.Parent !== game) {
		topServiceInst = topServiceInst.Parent;
	}
	return topServiceInst.Name;
}

// Walk up the ancestry to the enclosing package root — the first ancestor (or the instance itself)
// holding a PackageLink child. Studio does not reliably mark a Package as modified when a script inside
// it is edited programmatically (via ScriptEditorService / Source writes) rather than by a manual editor
// keystroke, and an unmarked package can be silently reverted by package auto-update / "Get Latest",
// losing the edit. Returns undefined when the script is not inside a package.
function findPackageRoot(instance: Instance): Instance | undefined {
	let current: Instance | undefined = instance;
	while (current !== undefined) {
		if (current.FindFirstChildOfClass("PackageLink") !== undefined) {
			return current;
		}
		current = current.Parent;
	}
	return undefined;
}

interface PackageWarningFields {
	packageWarning: string;
	packageRootPath: string;
}

// Build the advisory packageWarning/packageRootPath response fields for a script inside a package, or
// undefined when it is not. The warning is advisory only: it does not itself fix Studio's package-modified
// badge — the user must verify the badge (or publish the package) so the edit is not reverted.
function packageWarningFor(instance: Instance): PackageWarningFields | undefined {
	const packageRoot = findPackageRoot(instance);
	if (packageRoot === undefined) {
		return undefined;
	}
	const rootPath = packageRoot.GetFullName();
	return {
		packageWarning: `Edited script is inside package '${rootPath}'. Studio may not mark the package as modified for programmatic edits; unmarked packages can be silently reverted by package auto-update or "Get Latest". Verify the package shows the modified badge (a one-character manual edit-and-undo in the script editor forces it), or publish the package.`,
		packageRootPath: rootPath,
	};
}

// Attach package-warning fields to a successful-edit response in place. `result` is the handler's
// success object (typed unknown coming out of pcall); it is guarded to a table before mutation, and a
// no-op when the edited script is not inside a package.
function applyPackageWarning(result: unknown, packageFields: PackageWarningFields | undefined): void {
	if (packageFields === undefined) {
		return;
	}
	if (!typeIs(result, "table")) {
		return;
	}
	const record = result as Record<string, unknown>;
	record.packageWarning = packageFields.packageWarning;
	record.packageRootPath = packageFields.packageRootPath;
}

function sliceLines(lines: string[], startLine: number, endLine: number): string[] {
	const selectedLines: string[] = [];
	for (let i = startLine; i <= endLine; i++) {
		selectedLines.push(lines[i - 1] ?? "");
	}
	return selectedLines;
}

function numberLines(lines: string[], lineOffset: number): string {
	const numberedLines: string[] = [];
	for (let i = 0; i < lines.size(); i++) {
		numberedLines.push(`${i + lineOffset}: ${lines[i]}`);
	}
	return numberedLines.join("\n");
}

function getScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number | undefined;
	const endLine = requestData.endLine as number | undefined;

	if (!instancePath) return { error: "Instance path is required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [success, result] = pcall(() => {
		const fullSource = readScriptSource(instance);
		const [lines, hasTrailingNewline] = splitLines(fullSource);
		const totalLineCount = lines.size();
		const explicitRange = startLine !== undefined || endLine !== undefined;
		const shouldTruncate = !explicitRange &&
			(fullSource.size() > SOURCE_TRUNCATE_CHAR_BUDGET || totalLineCount > SOURCE_TRUNCATE_LINE_BUDGET);
		const returnedStartLine = explicitRange ? math.max(1, startLine ?? 1) : 1;
		const returnedEndLine = shouldTruncate
			? math.min(SOURCE_TRUNCATE_TO_LINES, totalLineCount)
			: explicitRange ? math.min(totalLineCount, endLine ?? totalLineCount) : totalLineCount;
		const selectedLines = (explicitRange || shouldTruncate)
			? sliceLines(lines, returnedStartLine, returnedEndLine)
			: lines;
		const sourceToReturn = explicitRange
			? joinLines(selectedLines, hasTrailingNewline && returnedEndLine === totalLineCount)
			: shouldTruncate ? selectedLines.join("\n") : fullSource;

		const resp: Record<string, unknown> = {
			instancePath,
			className: instance.ClassName,
			name: instance.Name,
			source: sourceToReturn,
			numberedSource: numberLines(selectedLines, returnedStartLine),
			sourceLength: fullSource.size(),
			lineCount: totalLineCount,
			startLine: returnedStartLine,
			endLine: returnedEndLine,
			isPartial: explicitRange,
			truncated: shouldTruncate,
		};

		if (shouldTruncate) {
			resp.note = `Script truncated to first ${returnedEndLine} of ${totalLineCount} lines (${fullSource.size()} chars). Use line_range to read specific sections.`;
		}

		if (instance.IsA("BaseScript")) {
			resp.enabled = instance.Enabled;
		}

		resp.topService = getTopServiceName(instance);

		return resp;
	});

	if (success) {
		return result;
	} else {
		return { error: `Failed to get script source: ${result}` };
	}
}

function setScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const newSource = requestData.source as string;

	// An empty string is a valid source (clearing a script), so check for a missing/non-string value
	// rather than a truthiness test (which would reject "").
	if (!instancePath || !typeIs(newSource, "string")) return { error: "Instance path and source are required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	// Resolve package membership before mutating — the replace fallback below destroys `instance`, and
	// the replacement is re-parented under the same (still package-owned) ancestor, so the root is the same.
	const packageFields = packageWarningFor(instance);
	const sourceToSet = newSource;
	const recordingId = beginRecording(`Set script source: ${instance.Name}`);

	const [updateSuccess, updateResult] = pcall(() => {
		const oldSourceLength = readScriptSource(instance).size();

		ScriptEditorService.UpdateSourceAsync(instance, () => sourceToSet);
		if (readScriptSource(instance) !== sourceToSet) {
			error("UpdateSourceAsync completed without updating the script source");
		}

		return {
			success: true, instancePath,
			oldSourceLength, newSourceLength: sourceToSet.size(),
			method: "UpdateSourceAsync",
			message: "Script source updated successfully (editor-safe)",
		};
	});

	if (updateSuccess) {
		finishRecording(recordingId, true);
		applyPackageWarning(updateResult, packageFields);
		return updateResult;
	}

	const [directSuccess, directResult] = pcall(() => {
		const oldSource = (instance as unknown as { Source: string }).Source;
		(instance as unknown as { Source: string }).Source = sourceToSet;

		return {
			success: true, instancePath,
			oldSourceLength: oldSource.size(), newSourceLength: sourceToSet.size(),
			method: "direct",
			message: "Script source updated successfully (direct assignment)",
		};
	});

	if (directSuccess) {
		finishRecording(recordingId, true);
		applyPackageWarning(directResult, packageFields);
		return directResult;
	}

	const [replaceSuccess, replaceResult] = pcall(() => {
		const parent = instance.Parent;
		const name = instance.Name;
		const className = instance.ClassName;
		const wasBaseScript = instance.IsA("BaseScript");
		const enabled = wasBaseScript ? instance.Enabled : undefined;

		const newScript = new Instance(className as keyof CreatableInstances) as LuaSourceContainer;
		newScript.Name = name;
		(newScript as unknown as { Source: string }).Source = sourceToSet;
		if (wasBaseScript && enabled !== undefined) {
			(newScript as BaseScript).Enabled = enabled;
		}

		newScript.Parent = parent;
		instance.Destroy();

		return {
			success: true,
			instancePath: getInstancePath(newScript),
			method: "replace",
			message: "Script replaced successfully with new source",
		};
	});

	if (replaceSuccess) {
		finishRecording(recordingId, true);
		applyPackageWarning(replaceResult, packageFields);
		return replaceResult;
	}

	finishRecording(recordingId, false);
	return {
		error: `Failed to set script source. UpdateSourceAsync failed: ${updateResult}. Direct assignment failed: ${directResult}. Replace method failed: ${replaceResult}`,
	};
}

function editScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const oldString = requestData.old_string as string;
	const newString = requestData.new_string as string;
	const startLine = requestData.startLine as number | undefined;

	if (!instancePath || oldString === undefined || newString === undefined) {
		return { error: "Instance path, old_string, and new_string are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const packageFields = packageWarningFor(instance);
	const recordingId = beginRecording(`Edit script: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const source = readScriptSource(instance);
		const searchLen = oldString.size();
		let matchStart: number;

		if (startLine !== undefined) {
			if (startLine < 1) error(`startLine must be >= 1 (got ${startLine})`);

			let lineStartByte = 1;
			let currentLine = 1;
			while (currentLine < startLine) {
				const [nlPos] = string.find(source, "\n", lineStartByte, true);
				if (nlPos === undefined) {
					error(`startLine ${startLine} is past end of script (${currentLine} lines)`);
				}
				lineStartByte = (nlPos as number) + 1;
				currentLine++;
			}

			const candidate = string.sub(source, lineStartByte, lineStartByte + searchLen - 1);
			if (candidate !== oldString) {
				error(`old_string does not match at line ${startLine}. Use get_script_source to verify the exact text at that line.`);
			}
			matchStart = lineStartByte;
		} else {
			let count = 0;
			let searchPos = 1;
			let firstMatch: number | undefined;
			while (true) {
				const [foundStart] = string.find(source, oldString, searchPos, true);
				if (foundStart === undefined) break;
				if (firstMatch === undefined) firstMatch = foundStart;
				count++;
				if (count > 1) break;
				searchPos = foundStart + searchLen;
			}
			if (count === 0) error("old_string not found in script. If old_string contains repeated patterns (e.g. closing braces), pass startLine to anchor the edit.");
			if (count > 1) error("old_string matches multiple locations. Provide more surrounding context, or pass startLine to anchor the edit to a specific line.");
			matchStart = firstMatch as number;
		}

		// Byte-slice replacement avoids Lua pattern escaping (safe for multi-byte chars like em dashes).
		const newSource = string.sub(source, 1, matchStart - 1) + newString + string.sub(source, matchStart + searchLen);

		ScriptEditorService.UpdateSourceAsync(instance, () => newSource);

		return {
			success: true,
			instancePath,
			message: "Script edited successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		applyPackageWarning(result, packageFields);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to edit script: ${result}` };
}

function insertScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const afterLine = (requestData.afterLine as number) ?? 0;
	const newContent = requestData.newContent as string;

	// An empty string is valid content (e.g. inserting a blank line), so check type rather than truthiness.
	if (!instancePath || !typeIs(newContent, "string")) return { error: "Instance path and newContent are required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const packageFields = packageWarningFor(instance);
	const recordingId = beginRecording(`Insert script lines after line ${afterLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(readScriptSource(instance));
		const totalLines = lines.size();

		if (afterLine < 0 || afterLine > totalLines) error(`afterLine out of range (0-${totalLines})`);

		const [newLines] = splitLines(newContent);
		const resultLines: string[] = [];

		for (let i = 0; i < afterLine; i++) resultLines.push(lines[i]);
		for (const line of newLines) resultLines.push(line);
		for (let i = afterLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		ScriptEditorService.UpdateSourceAsync(instance, () => newSource);

		return {
			success: true, instancePath,
			insertedAfterLine: afterLine,
			linesInserted: newLines.size(),
			newLineCount: resultLines.size(),
			message: "Script lines inserted successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		applyPackageWarning(result, packageFields);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to insert script lines: ${result}` };
}

function deleteScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number;
	const endLine = requestData.endLine as number;

	if (!instancePath || !startLine || !endLine) {
		return { error: "Instance path, startLine, and endLine are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const packageFields = packageWarningFor(instance);
	const recordingId = beginRecording(`Delete script lines ${startLine}-${endLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(readScriptSource(instance));
		const totalLines = lines.size();

		if (startLine < 1 || startLine > totalLines) error(`startLine out of range (1-${totalLines})`);
		if (endLine < startLine || endLine > totalLines) error(`endLine out of range (${startLine}-${totalLines})`);

		const resultLines: string[] = [];
		for (let i = 0; i < startLine - 1; i++) resultLines.push(lines[i]);
		for (let i = endLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		ScriptEditorService.UpdateSourceAsync(instance, () => newSource);

		return {
			success: true, instancePath,
			deletedLines: { startLine, endLine },
			linesDeleted: endLine - startLine + 1,
			newLineCount: resultLines.size(),
			message: "Script lines deleted successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		applyPackageWarning(result, packageFields);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to delete script lines: ${result}` };
}

function escapeLuaPattern(s: string): string {
	return s.gsub("([%(%)%.%%%+%-%*%?%[%]%^%$])", "%%%1")[0];
}

function escapeLuaReplacement(s: string): string {
	return s.gsub("%%", "%%%%")[0];
}

function caseInsensitiveLiteralReplace(src: string, searchStr: string, repl: string): [string, number] {
	const lowerSrc = src.lower();
	const lowerSearch = searchStr.lower();
	const parts: string[] = [];
	let lastEnd = 1;
	const searchLen = lowerSearch.size();
	let pos = 1;
	let replCount = 0;

	while (true) {
		const [foundStart] = string.find(lowerSrc, lowerSearch, pos, true);
		if (foundStart === undefined) break;
		parts.push(string.sub(src, lastEnd, foundStart - 1));
		parts.push(repl);
		lastEnd = foundStart + searchLen;
		pos = foundStart + searchLen;
		replCount++;
	}
	parts.push(string.sub(src, lastEnd));
	return [parts.join(""), replCount];
}

function findAndReplaceInScripts(requestData: Record<string, unknown>) {
	const searchPattern = requestData.pattern as string;
	const replacement = requestData.replacement as string;

	if (!searchPattern) return { error: "pattern is required" };
	if (replacement === undefined) return { error: "replacement is required" };

	const caseSensitive = (requestData.caseSensitive as boolean) ?? false;
	const usePattern = (requestData.usePattern as boolean) ?? false;
	const searchPath = (requestData.path as string) ?? "";
	const classFilter = requestData.classFilter as string | undefined;
	const dryRun = (requestData.dryRun as boolean) ?? false;
	const maxReplacements = (requestData.maxReplacements as number) ?? 1000;

	if (!caseSensitive && usePattern) {
		return { error: "Case-insensitive Lua pattern replacement is not supported. Use caseSensitive: true with usePattern: true, or use literal matching." };
	}

	const startInstance = searchPath !== "" ? getInstanceByPath(searchPath) : game;
	if (!startInstance) return { error: `Path not found: ${searchPath}` };

	interface ScriptChange {
		instancePath: string;
		name: string;
		className: string;
		replacements: number;
	}

	const changes: ScriptChange[] = [];
	// Deduped by package root full-name so multiple edited scripts in one package produce a single warning.
	const packageWarningsByRoot = new Map<string, string>();
	let totalReplacements = 0;
	let scriptsSearched = 0;
	let hitLimit = false;

	const recordingId = dryRun ? undefined : beginRecording("Find and replace in scripts");

	function processInstance(instance: Instance) {
		if (hitLimit) return;

		if (instance.IsA("LuaSourceContainer")) {
			if (classFilter && !instance.ClassName.lower().find(classFilter.lower())[0]) return;

			scriptsSearched++;
			const source = readScriptSource(instance);

			let newSource: string;
			let replCount: number;

			if (usePattern) {
				const [result, count] = string.gsub(source, searchPattern, replacement);
				newSource = result;
				replCount = count;
			} else if (caseSensitive) {
				const escaped = escapeLuaPattern(searchPattern);
				const escapedRepl = escapeLuaReplacement(replacement);
				const [result, count] = string.gsub(source, escaped, escapedRepl);
				newSource = result;
				replCount = count;
			} else {
				[newSource, replCount] = caseInsensitiveLiteralReplace(source, searchPattern, replacement);
			}

			if (replCount > 0) {
				if (totalReplacements + replCount > maxReplacements) {
					hitLimit = true;
					return;
				}
				totalReplacements += replCount;

				if (!dryRun) {
					const [ok] = pcall(() => {
						ScriptEditorService.UpdateSourceAsync(instance, () => newSource);
					});
					if (!ok) {
						(instance as unknown as { Source: string }).Source = newSource;
					}

					const packageFields = packageWarningFor(instance);
					if (packageFields !== undefined) {
						packageWarningsByRoot.set(packageFields.packageRootPath, packageFields.packageWarning);
					}
				}

				changes.push({
					instancePath: getInstancePath(instance),
					name: instance.Name,
					className: instance.ClassName,
					replacements: replCount,
				});
			}
		}

		for (const child of instance.GetChildren()) {
			if (hitLimit) return;
			processInstance(child);
		}
	}

	processInstance(startInstance);

	if (recordingId !== undefined) {
		finishRecording(recordingId, changes.size() > 0);
	}

	const packageWarnings: PackageWarningFields[] = [];
	for (const [rootPath, warning] of packageWarningsByRoot) {
		packageWarnings.push({ packageRootPath: rootPath, packageWarning: warning });
	}

	const response: Record<string, unknown> = {
		success: true,
		dryRun,
		pattern: searchPattern,
		replacement,
		totalReplacements,
		scriptsSearched,
		scriptsModified: changes.size(),
		changes,
		truncated: hitLimit,
	};
	if (packageWarnings.size() > 0) {
		response.packageWarnings = packageWarnings;
	}
	return response;
}

export = {
	getScriptSource,
	setScriptSource,
	editScriptLines,
	insertScriptLines,
	deleteScriptLines,
	findAndReplaceInScripts,
};
