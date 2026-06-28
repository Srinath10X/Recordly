import net from "node:net";

/**
 * Hyprland cursor tracking.
 *
 * Plain Wayland exposes no global cursor position, but Hyprland's IPC does:
 * `cursorpos` gives the pointer in logical coordinates and `clients` gives every
 * window's logical geometry. We find the window under the cursor and normalize
 * the pointer against ITS bounds — yielding the window-relative 0..1 position the
 * cursor overlay / click effects need, correct even when the editor zooms (the
 * captured video is that same window, so normalized coords map 1:1).
 */

type HyprClient = {
	address: string;
	class: string;
	title: string;
	mapped: boolean;
	hidden: boolean;
	at: [number, number];
	size: [number, number];
	focusHistoryID: number;
};

type NormalizedCursor = { cx: number; cy: number; updatedAt: number };

let running = false;
let clients: HyprClient[] = [];
let latest: NormalizedCursor | null = null;
let monitorScale = 1;
let capturedStreamSize: { width: number; height: number } | null = null;
let lockedAddress: string | null = null;

export function isHyprland(): boolean {
	return Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);
}

/**
 * The captured video resolution, forwarded from the renderer's
 * videoTrack.getSettings(). Used to pin cursor normalization to the ONE window
 * the portal is recording (its content px = window.size * monitor scale), so the
 * cursor stays in sync with the video instead of jumping between windows.
 */
export function setCapturedStreamSize(width: number, height: number): void {
	capturedStreamSize =
		Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
			? { width, height }
			: null;
	lockedAddress = null;
}

function socketPath(): string | null {
	const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (!sig || !runtime) return null;
	return `${runtime}/hypr/${sig}/.socket.sock`;
}

/** One request per connection, mirroring hyprctl. */
function hyprQuery(command: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const path = socketPath();
		if (!path) {
			reject(new Error("Hyprland socket unavailable"));
			return;
		}
		const sock = net.connect(path);
		let data = "";
		sock.on("connect", () => sock.write(command));
		sock.on("data", (chunk) => {
			data += chunk.toString();
		});
		sock.on("end", () => resolve(data));
		sock.on("error", reject);
	});
}

function contains(c: HyprClient, gx: number, gy: number): boolean {
	return (
		gx >= c.at[0] && gx < c.at[0] + c.size[0] && gy >= c.at[1] && gy < c.at[1] + c.size[1]
	);
}

function isCapturable(c: HyprClient): boolean {
	// Exclude Recordly's own windows (HUD / editor) so they never hijack coords.
	return c.mapped && !c.hidden && !/recordly/i.test(c.class);
}

function pickWindowUnderCursor(gx: number, gy: number): HyprClient | null {
	const candidates = clients.filter((c) => isCapturable(c) && contains(c, gx, gy));
	// Most-recently-focused window under the cursor is the one being interacted with.
	candidates.sort((a, b) => a.focusHistoryID - b.focusHistoryID);
	return candidates[0] ?? null;
}

/**
 * Resolve the captured window. Prefer locking onto the window whose content size
 * matches the recorded video resolution (window.size * scale), so the cursor is
 * always normalized against the SAME window the video shows. Falls back to
 * whichever window is under the cursor when the size is unknown/ambiguous.
 */
function resolveCapturedWindow(gx: number, gy: number): HyprClient | null {
	if (lockedAddress) {
		const locked = clients.find((c) => c.address === lockedAddress);
		if (locked) return locked;
		lockedAddress = null; // window closed — re-resolve
	}

	if (capturedStreamSize) {
		const tol = 3;
		const matches = clients.filter(
			(c) =>
				isCapturable(c) &&
				Math.abs(Math.round(c.size[0] * monitorScale) - capturedStreamSize!.width) <= tol &&
				Math.abs(Math.round(c.size[1] * monitorScale) - capturedStreamSize!.height) <= tol,
		);
		if (matches.length > 0) {
			const under = matches.filter((c) => contains(c, gx, gy));
			const chosen = (under.length ? under : matches).sort(
				(a, b) => a.focusHistoryID - b.focusHistoryID,
			)[0];
			lockedAddress = chosen.address;
			return chosen;
		}
	}

	return pickWindowUnderCursor(gx, gy);
}

async function refreshClients(): Promise<void> {
	try {
		const parsed = JSON.parse(await hyprQuery("j/clients")) as HyprClient[];
		if (Array.isArray(parsed)) clients = parsed;
	} catch {
		// transient socket error — keep the previous client list
	}
}

async function pollCursor(): Promise<void> {
	try {
		const raw = await hyprQuery("cursorpos");
		const [gx, gy] = raw.split(",").map((s) => Number(s.trim()));
		if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
		const win = resolveCapturedWindow(gx, gy);
		if (!win) {
			// Pointer is off the captured window — stop updating so the overlay holds
			// its last on-window spot rather than snapping somewhere wrong.
			return;
		}
		const cx = (gx - win.at[0]) / Math.max(1, win.size[0]);
		const cy = (gy - win.at[1]) / Math.max(1, win.size[1]);
		latest = {
			cx: cx < 0 ? 0 : cx > 1 ? 1 : cx,
			cy: cy < 0 ? 0 : cy > 1 ? 1 : cy,
			updatedAt: Date.now(),
		};
	} catch {
		// ignore transient errors
	}
}

/** Latest window-relative cursor, or null if tracking is off / stale. */
export function getHyprlandNormalizedCursor(): { cx: number; cy: number } | null {
	if (!latest) return null;
	if (Date.now() - latest.updatedAt > 1000) return null;
	return { cx: latest.cx, cy: latest.cy };
}

async function refreshMonitorScale(): Promise<void> {
	try {
		const monitors = JSON.parse(await hyprQuery("j/monitors")) as Array<{ scale: number }>;
		// ponytail: single-monitor assumption; per-window monitor scale if multi-monitor matters.
		if (monitors[0]?.scale) monitorScale = monitors[0].scale;
	} catch {
		monitorScale = 1;
	}
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Self-scheduling loops: each awaits its query before the next, so there is never
// more than one connection in flight. The Hyprland command socket throws EAGAIN
// under a connection storm (which a non-awaiting setInterval produced), and that
// staleness is exactly what made the cursor lag.
async function cursorLoop(): Promise<void> {
	while (running) {
		await pollCursor();
		await delay(33); // ~30Hz cap, non-overlapping — enough for a smooth cursor,
		// half the main-process socket churn of 60Hz during recording.
	}
}

async function clientLoop(): Promise<void> {
	while (running) {
		await refreshClients();
		await delay(500);
	}
}

export function startHyprlandCursorTracking(): void {
	if (!isHyprland() || running) return;
	clients = [];
	latest = null;
	lockedAddress = null;
	running = true;
	void refreshMonitorScale();
	void cursorLoop();
	void clientLoop();
}

export function stopHyprlandCursorTracking(): void {
	running = false;
	clients = [];
	latest = null;
}
