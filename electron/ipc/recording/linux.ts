import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow } from "electron";
import {
	linuxCaptureStopRequested,
	linuxCaptureTargetPath,
	linuxNativeCaptureActive,
	selectedSource,
	setLinuxCaptureProcess,
	setLinuxCaptureStopRequested,
	setLinuxNativeCaptureActive,
} from "../state";
import { emitRecordingInterrupted } from "./events";

const execFileAsync = promisify(execFile);

export type LinuxCaptureSession = "wayland" | "x11";

/** Wayland vs X11/XWayland. Falls back to WAYLAND_DISPLAY when XDG_SESSION_TYPE is unset. */
export function detectLinuxSession(): LinuxCaptureSession {
	const sessionType = (process.env.XDG_SESSION_TYPE ?? "").toLowerCase();
	if (sessionType === "wayland") return "wayland";
	if (sessionType === "x11") return "x11";
	return process.env.WAYLAND_DISPLAY ? "wayland" : "x11";
}

async function which(cmd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("which", [cmd]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/**
 * ponytail: prefer SYSTEM ffmpeg. The bundled ffmpeg-static almost certainly
 * lacks the pipewiregrab filter and the pulse input device.
 */
export async function resolveSystemFfmpegPath(): Promise<string | null> {
	return which("ffmpeg");
}

export async function ffmpegSupportsFilter(
	ffmpegPath: string,
	filter: string,
): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(ffmpegPath, ["-hide_banner", "-filters"], {
			maxBuffer: 8 * 1024 * 1024,
		});
		return stdout.includes(filter);
	} catch {
		return false;
	}
}

export async function isNativeLinuxCaptureAvailable(): Promise<{
	available: boolean;
	session: LinuxCaptureSession;
	reason?: string;
}> {
	const session = detectLinuxSession();
	if (process.platform !== "linux") {
		return { available: false, session, reason: "not-linux" };
	}

	const ffmpegPath = await resolveSystemFfmpegPath();
	if (!ffmpegPath) {
		return { available: false, session, reason: "system ffmpeg not found on PATH" };
	}

	if (session === "wayland") {
		const ok = await ffmpegSupportsFilter(ffmpegPath, "pipewiregrab");
		if (!ok) {
			return {
				available: false,
				session,
				reason: "system ffmpeg lacks the pipewiregrab filter (needs ffmpeg 2024+)",
			};
		}
	}

	return { available: true, session };
}

/** System audio = the default sink's `.monitor` source. null if pactl is unavailable. */
export async function resolvePulseMonitorSource(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("pactl", ["get-default-sink"]);
		const sink = stdout.trim();
		if (sink) return `${sink}.monitor`;
	} catch {
		// pactl missing or PipeWire-without-pulse-shim — skip system audio.
	}
	return null;
}

export type LinuxFfmpegArgsOptions = {
	session: LinuxCaptureSession;
	outputPath: string;
	captureSystemAudio: boolean;
	captureMicrophone: boolean;
	systemAudioSource: string;
	/** pulse device name; "default" is acceptable. */
	microphoneSource: string;
	/** Required for X11; physical-pixel geometry of the captured display. */
	display?: { x: number; y: number; width: number; height: number; displayEnv: string };
};

export function buildLinuxFfmpegArgs(opts: LinuxFfmpegArgsOptions): string[] {
	const args: string[] = ["-hide_banner"];

	// Video input (index 0).
	if (opts.session === "wayland") {
		// Wayland exposes no global cursor position, so we bake the real cursor in
		// (draw_mouse=1) and the editor leaves the animated overlay off.
		args.push("-f", "lavfi", "-i", "pipewiregrab=draw_mouse=1");
	} else {
		const d = opts.display;
		if (!d) throw new Error("X11 capture requires display bounds");
		// draw_mouse=0: the X11 telemetry overlay renders the cursor itself.
		args.push(
			"-f",
			"x11grab",
			"-draw_mouse",
			"0",
			"-framerate",
			"60",
			"-video_size",
			`${d.width}x${d.height}`,
			"-i",
			`${d.displayEnv}+${d.x},${d.y}`,
		);
	}

	// Audio inputs (pulse). System monitor first, then mic.
	const audioInputs: number[] = [];
	let nextInput = 1;
	if (opts.captureSystemAudio) {
		args.push("-f", "pulse", "-i", opts.systemAudioSource);
		audioInputs.push(nextInput++);
	}
	if (opts.captureMicrophone) {
		args.push("-f", "pulse", "-i", opts.microphoneSource);
		audioInputs.push(nextInput++);
	}

	args.push("-r", "60", "-map", "0:v");
	if (audioInputs.length === 2) {
		args.push(
			"-filter_complex",
			`[${audioInputs[0]}:a][${audioInputs[1]}:a]amix=inputs=2[a]`,
			"-map",
			"[a]",
		);
	} else if (audioInputs.length === 1) {
		args.push("-map", `${audioInputs[0]}:a`);
	}

	args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
	if (audioInputs.length > 0) {
		args.push("-c:a", "aac");
	}
	args.push("-movflags", "+faststart", "-y", opts.outputPath);

	return args;
}

export function waitForLinuxCaptureStart(proc: ChildProcessWithoutNullStreams) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for native Linux capture to start"));
		}, 15000);

		let buffer = "";
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString();
			// ffmpeg prints "frame=" once it begins encoding the first frame.
			if (buffer.includes("frame=")) {
				cleanup();
				resolve();
			}
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					buffer.trim() ||
						`ffmpeg exited before recording started (code ${code ?? "unknown"})`,
				),
			);
		};
		const cleanup = () => {
			clearTimeout(timer);
			proc.stderr.off("data", onData);
			proc.off("error", onError);
			proc.off("exit", onExit);
		};

		proc.stderr.on("data", onData);
		proc.once("error", onError);
		proc.once("exit", onExit);
	});
}

export function waitForLinuxCaptureStop(
	proc: ChildProcessWithoutNullStreams,
	timeoutMs = 45000,
) {
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};

		const timer = setTimeout(() => {
			finish(() => {
				try {
					if (!proc.killed) proc.kill("SIGKILL");
				} catch {
					// already gone
				}
				reject(new Error("Timed out waiting for native Linux capture to stop"));
			});
		}, timeoutMs);

		const onClose = (code: number | null) => {
			finish(() => {
				// 'q' on stdin makes ffmpeg finalize the moov atom and exit 0 (255 on a
				// signal-style quit); either way the target file is the deliverable.
				if (linuxCaptureTargetPath) {
					resolve(linuxCaptureTargetPath);
					return;
				}
				reject(new Error(`ffmpeg exited with code ${code ?? "unknown"}`));
			});
		};
		const onError = (error: Error) => finish(() => reject(error));
		const cleanup = () => {
			clearTimeout(timer);
			proc.off("close", onClose);
			proc.off("error", onError);
		};

		proc.once("close", onClose);
		proc.once("error", onError);
	});
}

export function attachLinuxCaptureLifecycle(proc: ChildProcessWithoutNullStreams) {
	proc.once("close", () => {
		const wasActive = linuxNativeCaptureActive;
		setLinuxCaptureProcess(null);

		if (!wasActive || linuxCaptureStopRequested) {
			return;
		}

		setLinuxNativeCaptureActive(false);
		setLinuxCaptureStopRequested(false);

		const sourceName = selectedSource?.name ?? "Screen";
		BrowserWindow.getAllWindows().forEach((window) => {
			if (!window.isDestroyed()) {
				window.webContents.send("recording-state-changed", {
					recording: false,
					sourceName,
				});
			}
		});

		emitRecordingInterrupted("capture-stopped", "Recording stopped unexpectedly.");
	});
}
