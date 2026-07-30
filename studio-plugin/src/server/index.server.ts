import State from "../modules/State";
import UI from "../modules/UI";
import Communication from "../modules/Communication";
import ClientBroker from "../modules/ClientBroker";
import ServerUrlSettings from "../modules/ServerUrlSettings";
import ConnectStateSettings from "../modules/ConnectStateSettings";
import { cleanupLegacyEditBridges, ensureRuntimeBridgeInstalled } from "../modules/EvalBridges";
import RuntimeLogBuffer from "../modules/RuntimeLogBuffer";
import StopPlayMonitor from "../modules/StopPlayMonitor";
import BreakpointHandlers from "../modules/handlers/BreakpointHandlers";
import * as RenderMonitor from "../modules/RenderMonitor";

// Track render-loop liveness so input/screenshot tools can report "window
// minimized / not rendering" instead of silently no-op'ing. No-op in the
// server DM (RenderStepped can't connect there).
RenderMonitor.start();

// Attach the per-peer LogService.MessageOut listener as early as possible so
// boot-time prints from the user's place scripts are captured. Powers the
// get_runtime_logs MCP tool. Idempotent; safe to call before UI.init().
RuntimeLogBuffer.install();

// Share the plugin reference with the stop-play signaling module so both the
// edit DM (write the flag) and the play-server DM (read+act on the flag) can
// access plugin:SetSetting/GetSetting.
StopPlayMonitor.init(plugin);
BreakpointHandlers.init(plugin);
ServerUrlSettings.init(plugin);
ConnectStateSettings.init(plugin);

function applyRememberedServerUrl(): void {
	if (ClientBroker.forkRole() === "client") return;

	const rememberedServerUrl = ServerUrlSettings.readServerUrl();
	if (rememberedServerUrl === undefined) return;

	const conn = State.getActiveConnection();
	conn.serverUrl = rememberedServerUrl;
	const port = ServerUrlSettings.extractPort(rememberedServerUrl);
	if (port !== undefined) conn.port = port;
	ClientBroker.setServerUrl(rememberedServerUrl);
}

applyRememberedServerUrl();

UI.init(plugin);
const elements = UI.getElements();


const ICON_DISCONNECTED = "rbxassetid://__BUTTON_ICON_DISCONNECTED__";
const ICON_CONNECTING = "rbxassetid://__BUTTON_ICON_CONNECTING__";
const ICON_CONNECTED = "rbxassetid://__BUTTON_ICON_CONNECTED__";
const TOOLBAR_REGISTRATION_DELAY_SECONDS = 1;

let toolbarButtonRegistered = false;

function registerToolbarButton() {
	if (toolbarButtonRegistered) {
		return;
	}
	toolbarButtonRegistered = true;

	const toolbar = plugin.CreateToolbar("__TOOLBAR_NAME__");
	const button = toolbar.CreateButton("__BUTTON_TITLE__", "__BUTTON_TOOLTIP__", ICON_DISCONNECTED);
	UI.setToolbarButton(button, { disconnected: ICON_DISCONNECTED, connecting: ICON_CONNECTING, connected: ICON_CONNECTED });

	button.Click.Connect(() => {
		elements.screenGui.Enabled = !elements.screenGui.Enabled;
	});
}


// Persist the choice before acting on it so play DMs - which never show this
// UI - can honor it. Only this click site records intent: deactivatePlugin()
// also runs on automatic teardown (play session ending, plugin unloading),
// and those must not be mistaken for the user switching the bridge off.
elements.connectButton.Activated.Connect(() => {
	const conn = State.getActiveConnection();
	if (conn && conn.isActive) {
		ConnectStateSettings.setEnabled(false);
		Communication.deactivatePlugin();
	} else {
		ConnectStateSettings.setEnabled(true);
		Communication.activatePlugin();
	}
});


plugin.Unloading.Connect(() => {
	Communication.deactivateAll();
});


UI.updateUIState();
Communication.checkForUpdates();
task.delay(TOOLBAR_REGISTRATION_DELAY_SECONDS, registerToolbarButton);

// Play DMs have no visible UI, so the user can only flip the switch from the
// edit DM. Poll the persisted flag so pressing Connect during a playtest still
// brings this peer online instead of leaving it dark until the next playtest.
// 1Hz matches StopPlayMonitor, which already polls plugin settings throughout
// every play session.
const CONNECT_WATCH_INTERVAL_SECONDS = 1;

let peerStarted = false;

// Bring this DataModel's peer online: install the runtime eval bridge (play
// DMs only), open the HTTP connection, and start the role's broker.
// Idempotent, because the watcher below can also call it once the user
// presses Connect mid-playtest.
function startPeer(role: "edit" | "server" | "client"): void {
	if (peerStarted) {
		return;
	}
	peerStarted = true;

	if (role !== "edit") {
		const result = ensureRuntimeBridgeInstalled();
		if (!result.installed) {
			warn(`[robloxstudio-mcp] Runtime eval bridge install failed: ${result.error}`);
		}
	}

	if (role === "edit" || role === "server") {
		pcall(() => {
			const conn = State.getActiveConnection();
			if (!conn.isActive) {
				if (role === "server") {
					const inheritedServerUrl = ServerUrlSettings.readServerUrl() ?? ClientBroker.DEFAULT_MCP_URL;
					conn.serverUrl = ServerUrlSettings.normalizeServerUrl(inheritedServerUrl);
					elements.urlInput.Text = conn.serverUrl;
					const port = ServerUrlSettings.extractPort(conn.serverUrl);
					if (port !== undefined) conn.port = port;
					ClientBroker.setServerUrl(conn.serverUrl);
				}
				// Defensive default: in invisible play-DM UIs, the input field
				// may not be populated by the time we activate.
				if (conn.serverUrl === undefined || conn.serverUrl === "") {
					conn.serverUrl = ClientBroker.DEFAULT_MCP_URL;
					elements.urlInput.Text = conn.serverUrl;
				}
				Communication.activatePlugin();
			}
		});
	}

	if (role === "server") {
		ClientBroker.setupServerBroker();
	} else if (role === "client") {
		ClientBroker.setupClientBroker();
	}
}

function watchForConnectEnable(role: "edit" | "server" | "client"): void {
	task.spawn(() => {
		while (!peerStarted) {
			if (ConnectStateSettings.isEnabled()) {
				startPeer(role);
				return;
			}
			task.wait(CONNECT_WATCH_INTERVAL_SECONDS);
		}
	});
}

// Auto-activate per peer. The boshyxd plugin only registers with MCP when the
// user clicks Connect in its UI, but that UI is invisible in play DMs - so
// play peers' plugin instances load without ever registering. Run after a
// short delay so the UI/State have a chance to initialize first.
//
// Gated on the user's persisted Connect/Disconnect choice. Each playtest
// builds fresh DataModels whose Connection starts inactive, so without the
// gate the play peers re-register - and warn on every failed /ready - even
// when the user has explicitly disconnected the bridge.
task.delay(2, () => {
	const role = ClientBroker.forkRole();
	if (role === "edit") {
		cleanupLegacyEditBridges();
	}

	// Deliberately outside the connect gate: the play-server DM is the only
	// place StudioTestService:EndTest is legal, and cross-DM stop signaling
	// goes through plugin settings rather than HTTP, so it must keep working
	// regardless of whether the MCP bridge is connected.
	if (role === "server") {
		StopPlayMonitor.startMonitor();
	}

	if (ConnectStateSettings.isEnabled()) {
		startPeer(role);
		return;
	}

	// The edit DM needs no watcher: its Connect button activates directly.
	if (role !== "edit") {
		watchForConnectEnable(role);
	}
});
