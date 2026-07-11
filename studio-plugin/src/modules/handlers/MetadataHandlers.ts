import { CollectionService } from "@rbxts/services";
import Utils from "../Utils";
import Recording from "../Recording";
import LuauExec from "../LuauExec";

const ChangeHistoryService = game.GetService("ChangeHistoryService");
const Selection = game.GetService("Selection");

const { getInstancePath, getInstanceByPath, serializeValue, maybeDecodeJsonTable } = Utils;
const { beginRecording, finishRecording } = Recording;

const STRUCTURED_ATTR_TYPES = new Set([
	"Vector2", "Vector3", "Color3", "CFrame", "UDim", "UDim2", "BrickColor",
]);

function deserializeValue(attributeValue: unknown, valueType?: string): unknown {
	// A structured value may arrive as a JSON string when the client stringifies it for the untyped
	// attributeValue field. Decode it back to a table when a structured type is indicated — either via a
	// structured valueType hint or an embedded _type tag (as returned by get_attribute) — so the tagged
	// branches below can rebuild it. A plain string with neither signal is left untouched.
	if (typeIs(attributeValue, "string")) {
		const decoded = maybeDecodeJsonTable(attributeValue);
		if (decoded !== undefined) {
			// Only adopt the decoded table when it names a real datatype — via a known _type tag (as
			// get_attribute returns) or a structured valueType hint. A JSON string that merely happens to
			// carry some other _type is left as a plain string rather than failing SetAttribute.
			const typeTag = (decoded as Record<string, unknown>)._type;
			const hasKnownTypeTag = typeIs(typeTag, "string") && STRUCTURED_ATTR_TYPES.has(typeTag);
			if (hasKnownTypeTag || (valueType !== undefined && STRUCTURED_ATTR_TYPES.has(valueType))) {
				attributeValue = decoded;
			}
		}
	}

	// Honor an explicit primitive type hint, coercing common stringified forms so booleans/numbers are
	// stored as real booleans/numbers whether the client sends a native JSON value or a string. This
	// mirrors the property path (convertPropertyValue), which the attribute path previously did not.
	if (valueType === "boolean") {
		if (typeIs(attributeValue, "boolean")) return attributeValue;
		return attributeValue === "true" || attributeValue === 1;
	}
	if (valueType === "number") {
		if (typeIs(attributeValue, "number")) return attributeValue;
		const n = tonumber(attributeValue);
		return n !== undefined ? n : attributeValue;
	}
	if (valueType === "string") {
		return typeIs(attributeValue, "string") ? attributeValue : tostring(attributeValue);
	}

	if (!typeIs(attributeValue, "table")) {
		// No structural/hinted type: coerce stringified booleans to real booleans (matches set_property).
		// Pass valueType:"string" to store a literal "true"/"false" string instead.
		if (attributeValue === "true") return true;
		if (attributeValue === "false") return false;
		return attributeValue;
	}

	const tbl = attributeValue as Record<string, unknown>;
	const t = (tbl._type as string) ?? valueType;

	if (t === "Vector3") {
		const a = tbl as unknown as number[];
		return new Vector3((tbl.X as number) ?? a[0] ?? 0, (tbl.Y as number) ?? a[1] ?? 0, (tbl.Z as number) ?? a[2] ?? 0);
	} else if (t === "Vector2") {
		const a = tbl as unknown as number[];
		return new Vector2((tbl.X as number) ?? a[0] ?? 0, (tbl.Y as number) ?? a[1] ?? 0);
	} else if (t === "Color3") {
		const a = tbl as unknown as number[];
		return new Color3((tbl.R as number) ?? a[0] ?? 0, (tbl.G as number) ?? a[1] ?? 0, (tbl.B as number) ?? a[2] ?? 0);
	} else if (t === "CFrame") {
		const comps = tbl.components as number[] | undefined;
		if (comps !== undefined && comps.size() >= 12) {
			return new CFrame(
				comps[0], comps[1], comps[2], comps[3], comps[4], comps[5],
				comps[6], comps[7], comps[8], comps[9], comps[10], comps[11],
			);
		}
		const pos = tbl.Position as Record<string, number> | undefined;
		if (pos !== undefined) return new CFrame(pos.X ?? 0, pos.Y ?? 0, pos.Z ?? 0);
		return attributeValue;
	} else if (t === "UDim2") {
		const x = tbl.X as Record<string, number> | undefined;
		const y = tbl.Y as Record<string, number> | undefined;
		return new UDim2(x?.Scale ?? 0, x?.Offset ?? 0, y?.Scale ?? 0, y?.Offset ?? 0);
	} else if (t === "UDim") {
		return new UDim((tbl.Scale as number) ?? 0, (tbl.Offset as number) ?? 0);
	} else if (t === "BrickColor") {
		return new BrickColor(((tbl.Name as string) ?? "Medium stone grey") as unknown as number);
	}
	return attributeValue;
}

function setAttribute(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const attributeName = requestData.attributeName as string;
	const attributeValue = requestData.attributeValue;
	const valueType = requestData.valueType as string | undefined;

	if (!instancePath || !attributeName) {
		return { error: "Instance path and attribute name are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	const recordingId = beginRecording(`Set attribute ${attributeName} on ${instance.Name}`);

	const [success, result] = pcall(() => {
		const value = deserializeValue(attributeValue, valueType);
		instance.SetAttribute(attributeName, value as AttributeValue);

		return {
			success: true, instancePath, attributeName,
			value: attributeValue, message: "Attribute set successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to set attribute: ${result}` };
}

function getAttributes(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	if (!instancePath) return { error: "Instance path is required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };

	const [success, result] = pcall(() => {
		const attributes = instance.GetAttributes();
		const serializedAttributes: Record<string, { value: unknown; type: string }> = {};
		let count = 0;

		for (const [name, value] of pairs(attributes)) {
			serializedAttributes[name as string] = {
				value: serializeValue(value),
				type: typeOf(value),
			};
			count++;
		}

		return { instancePath, attributes: serializedAttributes, count };
	});

	if (success) return result;
	return { error: `Failed to get attributes: ${result}` };
}

function deleteAttribute(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const attributeName = requestData.attributeName as string;

	if (!instancePath || !attributeName) {
		return { error: "Instance path and attribute name are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	const recordingId = beginRecording(`Delete attribute ${attributeName} from ${instance.Name}`);

	const [success, result] = pcall(() => {
		const existed = instance.GetAttribute(attributeName) !== undefined;
		instance.SetAttribute(attributeName, undefined);

		return {
			success: true, instancePath, attributeName, existed,
			message: existed ? "Attribute deleted successfully" : "Attribute did not exist",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to delete attribute: ${result}` };
}

function getTags(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	if (!instancePath) return { error: "Instance path is required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };

	const [success, result] = pcall(() => {
		const tags = CollectionService.GetTags(instance);
		return { instancePath, tags, count: tags.size() };
	});

	if (success) return result;
	return { error: `Failed to get tags: ${result}` };
}

function addTag(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const tagName = requestData.tagName as string;

	if (!instancePath || !tagName) {
		return { error: "Instance path and tag name are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	const recordingId = beginRecording(`Add tag ${tagName} to ${instance.Name}`);

	const [success, result] = pcall(() => {
		const alreadyHad = CollectionService.HasTag(instance, tagName);
		CollectionService.AddTag(instance, tagName);

		return {
			success: true, instancePath, tagName, alreadyHad,
			message: alreadyHad ? "Instance already had this tag" : "Tag added successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to add tag: ${result}` };
}

function removeTag(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const tagName = requestData.tagName as string;

	if (!instancePath || !tagName) {
		return { error: "Instance path and tag name are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	const recordingId = beginRecording(`Remove tag ${tagName} from ${instance.Name}`);

	const [success, result] = pcall(() => {
		const hadTag = CollectionService.HasTag(instance, tagName);
		CollectionService.RemoveTag(instance, tagName);

		return {
			success: true, instancePath, tagName, hadTag,
			message: hadTag ? "Tag removed successfully" : "Instance did not have this tag",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to remove tag: ${result}` };
}

function getTagged(requestData: Record<string, unknown>) {
	const tagName = requestData.tagName as string;
	if (!tagName) return { error: "Tag name is required" };

	const [success, result] = pcall(() => {
		const taggedInstances = CollectionService.GetTagged(tagName);
		const instances = taggedInstances.map((instance) => ({
			name: instance.Name,
			className: instance.ClassName,
			path: getInstancePath(instance),
		}));

		return { tagName, instances, count: instances.size() };
	});

	if (success) return result;
	return { error: `Failed to get tagged instances: ${result}` };
}

function getSelection(_requestData: Record<string, unknown>) {
	const selection = Selection.Get();

	if (selection.size() === 0) {
		return { success: true, selection: [], count: 0, message: "No objects selected" };
	}

	const selectedObjects = selection.map((instance: Instance) => ({
		name: instance.Name,
		className: instance.ClassName,
		path: getInstancePath(instance),
		parent: instance.Parent ? getInstancePath(instance.Parent) : undefined,
	}));

	return {
		success: true,
		selection: selectedObjects,
		count: selection.size(),
		message: `${selection.size()} object(s) selected`,
	};
}

function executeLuau(requestData: Record<string, unknown>) {
	const code = requestData.code as string;
	if (!code || code === "") return { error: "Code is required" };
	// All wrapping, print/warn capture, loadstring fallback, JSON-encoding
	// of table returns, and parse-error recovery live in LuauExec so the
	// edit/server (this handler) and the play-client (ClientBroker) take
	// the same code path and produce identical output shapes.
	return LuauExec.execute(code);
}

function undo(_requestData: Record<string, unknown>) {
	const [success, result] = pcall(() => {
		ChangeHistoryService.Undo();
		return {
			success: true,
			message: "Undo executed successfully",
		};
	});

	if (success) return result;
	return { error: `Failed to undo: ${result}` };
}

function redo(_requestData: Record<string, unknown>) {
	const [success, result] = pcall(() => {
		ChangeHistoryService.Redo();
		return {
			success: true,
			message: "Redo executed successfully",
		};
	});

	if (success) return result;
	return { error: `Failed to redo: ${result}` };
}

function bulkSetAttributes(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const attributes = requestData.attributes as Record<string, unknown>;

	if (!instancePath || !attributes) {
		return { error: "Instance path and attributes are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };

	const recordingId = beginRecording(`Bulk set attributes on ${instance.Name}`);

	const results: Record<string, unknown>[] = [];
	let successCount = 0;
	let failureCount = 0;

	for (const [name, rawValue] of pairs(attributes)) {
		const attrName = name as string;
		const [ok, err] = pcall(() => {
			const value = deserializeValue(rawValue);
			instance.SetAttribute(attrName, value as AttributeValue);
		});

		if (ok) {
			successCount++;
			results.push({ attributeName: attrName, success: true });
		} else {
			failureCount++;
			results.push({ attributeName: attrName, success: false, error: tostring(err) });
		}
	}

	finishRecording(recordingId, successCount > 0);

	return {
		instancePath,
		results,
		summary: { total: successCount + failureCount, succeeded: successCount, failed: failureCount },
	};
}

export = {
	setAttribute,
	getAttributes,
	deleteAttribute,
	getTags,
	addTag,
	removeTag,
	getTagged,
	getSelection,
	executeLuau,
	undo,
	redo,
	bulkSetAttributes,
};
