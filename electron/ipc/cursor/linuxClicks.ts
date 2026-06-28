import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";

export type LinuxButton = 1 | 2 | 3;

/**
 * Parse one line of `libinput debug-events` output into a button event.
 * Example: ` event6   POINTER_BUTTON   +7.005s\tBTN_LEFT (272) pressed, seat count: 1`
 *
 * libinput is used (not raw evdev) because it synthesizes tap-to-click and
 * two-finger right-click from touchpads, which the raw device never emits as
 * BTN_LEFT. Position is handled separately (Hyprland IPC), so we only need buttons.
 */
export function parseLibinputButtonLine(
	line: string,
): { button: LinuxButton; pressed: boolean } | null {
	if (!line.includes("POINTER_BUTTON")) return null;
	const match = /\bBTN_(LEFT|RIGHT|MIDDLE)\b.*\b(pressed|released)\b/.exec(line);
	if (!match) return null;
	const button: LinuxButton = match[1] === "RIGHT" ? 2 : match[1] === "MIDDLE" ? 3 : 1;
	return { button, pressed: match[2] === "pressed" };
}

function resolveLibinputPath(): string {
	for (const candidate of ["/usr/bin/libinput", "/usr/sbin/libinput", "/bin/libinput"]) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			/* ignore */
		}
	}
	return "libinput";
}

/**
 * Stream global mouse-button presses via `libinput debug-events --enable-tap`.
 * Reads a stdout pipe (epoll-based — does not block the libuv threadpool the way
 * reading /dev/input directly would). Requires read access to /dev/input (the
 * `input` group); no root. Returns a stop function.
 */
export function startLinuxClickCapture(
	onButton: (button: LinuxButton, pressed: boolean) => void,
): () => void {
	let child: ChildProcess;
	try {
		child = spawn(resolveLibinputPath(), ["debug-events", "--enable-tap"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return () => {};
	}

	let alive = true;
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let newline: number;
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line splitter
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const event = parseLibinputButtonLine(line);
			if (event) {
				onButton(event.button, event.pressed);
			}
		}
	});
	child.on("error", () => {
		alive = false;
	});

	return () => {
		if (alive) {
			alive = false;
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		}
	};
}
