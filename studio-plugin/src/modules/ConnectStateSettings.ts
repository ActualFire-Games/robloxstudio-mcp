// Cross-DM persistence of the user's Connect / Disconnect choice.
//
// `plugin:SetSetting` / `plugin:GetSetting` is a per-plugin persistent store
// shared by every DataModel the plugin runs in (edit DMs, play-server DMs,
// play-client DMs). The plugin's UI only exists in the edit DM, so without a
// persisted flag the play DMs have no way to know the user pressed
// Disconnect: every playtest spins up a fresh DataModel whose Connection
// starts inactive and is then auto-activated, registering with the MCP server
// (and warning on every failed /ready) even though the user explicitly turned
// the bridge off.
//
// Scoped per instance like MCP_STOP_PLAY_*, plus a global key so DMs that
// cannot see the edit DM's ServerStorage still resolve the user's choice:
// play-client DMs get their own empty ServerStorage, so the per-instance
// anon id is unavailable there.
//
// An unset flag means enabled. That preserves the original auto-connect
// behavior for anyone who never touches the button; only an explicit
// Disconnect turns the play-DM peers off.

import { HttpService, ServerStorage } from "@rbxts/services";

const SETTING_KEY_PREFIX = "MCP_CONNECT_ENABLED_";
const GLOBAL_SETTING_KEY = "MCP_CONNECT_ENABLED_GLOBAL_V1";

let pluginRef: Plugin | undefined;

function init(p: Plugin): void {
	pluginRef = p;
}

function addUnique(values: string[], value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}

// Mirror of Communication.computeInstanceId(), duplicated here for the same
// reason as in StopPlayMonitor: this module runs in edit, play-server and
// play-client DMs, and all of them must agree on the place identifier.
// createAnonymous is opt-in because reading a setting should never mint a
// place identity — doing so in a client DM would write a misleading anon id
// that never matches the edit/server bridge identity.
function computeInstanceIds(options?: { createAnonymous?: boolean }): string[] {
	const ids: string[] = [];
	if (game.PlaceId !== 0) {
		addUnique(ids, `place:${tostring(game.PlaceId)}`);
	}
	const existing = ServerStorage.GetAttribute("__MCPPlaceId");
	if (typeIs(existing, "string") && existing !== "") {
		addUnique(ids, `anon:${existing as string}`);
	} else if (game.PlaceId === 0 && options?.createAnonymous === true) {
		const fresh = HttpService.GenerateGUID(false);
		pcall(() => ServerStorage.SetAttribute("__MCPPlaceId", fresh));
		addUnique(ids, `anon:${fresh}`);
	}
	return ids;
}

function settingKey(instanceId: string): string {
	return SETTING_KEY_PREFIX + instanceId;
}

function readSettingBoolean(key: string): boolean | undefined {
	if (!pluginRef) return undefined;
	const [ok, value] = pcall(() => pluginRef!.GetSetting(key));
	if (!ok || !typeIs(value, "boolean")) return undefined;
	return value as boolean;
}

// Persist the user's explicit Connect (true) / Disconnect (false) choice.
// Written to both the per-instance key and the global key so any DM can
// resolve it regardless of which identity it can compute.
function setEnabled(enabled: boolean): void {
	if (!pluginRef) return;
	pcall(() => pluginRef!.SetSetting(GLOBAL_SETTING_KEY, enabled));
	for (const instanceId of computeInstanceIds({ createAnonymous: true })) {
		pcall(() => pluginRef!.SetSetting(settingKey(instanceId), enabled));
	}
}

// Resolve whether this DataModel's peer should connect to the MCP server.
// Per-instance keys win over the global key so a place the user disconnected
// stays disconnected even if another place was connected more recently.
// Defaults to true when nothing has been stored.
function isEnabled(): boolean {
	if (!pluginRef) return true;
	for (const instanceId of computeInstanceIds()) {
		const scoped = readSettingBoolean(settingKey(instanceId));
		if (scoped !== undefined) return scoped;
	}
	const global = readSettingBoolean(GLOBAL_SETTING_KEY);
	if (global !== undefined) return global;
	return true;
}

export = {
	init,
	setEnabled,
	isEnabled,
};
