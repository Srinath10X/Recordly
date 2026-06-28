import { afterEach, describe, expect, it } from "vitest";
import { buildLinuxFfmpegArgs, detectLinuxSession } from "./linux";

const X11_DISPLAY = { x: 0, y: 0, width: 1920, height: 1080, displayEnv: ":0.0" };

function argsFor(overrides: Partial<Parameters<typeof buildLinuxFfmpegArgs>[0]> = {}) {
	return buildLinuxFfmpegArgs({
		session: "wayland",
		outputPath: "/tmp/out.mp4",
		captureSystemAudio: false,
		captureMicrophone: false,
		systemAudioSource: "sink.monitor",
		microphoneSource: "default",
		...overrides,
	});
}

describe("buildLinuxFfmpegArgs", () => {
	it("Wayland bakes the cursor (draw_mouse=1) via pipewiregrab", () => {
		const args = argsFor({ session: "wayland" });
		expect(args).toContain("pipewiregrab=draw_mouse=1");
		expect(args[args.length - 1]).toBe("/tmp/out.mp4");
	});

	it("X11 does NOT bake the cursor (draw_mouse 0) and grabs the display rect", () => {
		const args = argsFor({ session: "x11", display: X11_DISPLAY });
		const i = args.indexOf("-draw_mouse");
		expect(args[i + 1]).toBe("0");
		expect(args).toContain("x11grab");
		expect(args).toContain("1920x1080");
		expect(args).toContain(":0.0+0,0");
	});

	it("throws on X11 without display bounds", () => {
		expect(() => argsFor({ session: "x11" })).toThrow();
	});

	it("no audio -> only video is mapped", () => {
		const args = argsFor();
		expect(args).toContain("-map");
		expect(args).toContain("0:v");
		expect(args).not.toContain("-c:a");
		expect(args).not.toContain("amix=inputs=2[a]");
	});

	it("system audio only -> single pulse input mapped as 1:a", () => {
		const args = argsFor({ captureSystemAudio: true });
		expect(args.filter((a) => a === "pulse")).toHaveLength(1);
		expect(args).toContain("sink.monitor");
		expect(args).toContain("1:a");
		expect(args).toContain("-c:a");
		expect(args).not.toContain("amix=inputs=2[a]");
	});

	it("mic only -> single pulse input mapped as 1:a", () => {
		const args = argsFor({ captureMicrophone: true });
		expect(args.filter((a) => a === "pulse")).toHaveLength(1);
		expect(args).toContain("default");
		expect(args).toContain("1:a");
	});

	it("system + mic -> two pulse inputs mixed via amix", () => {
		const args = argsFor({ captureSystemAudio: true, captureMicrophone: true });
		expect(args.filter((a) => a === "pulse")).toHaveLength(2);
		expect(args).toContain("[1:a][2:a]amix=inputs=2[a]");
		expect(args).toContain("[a]");
	});
});

describe("detectLinuxSession", () => {
	const original = { ...process.env };
	afterEach(() => {
		process.env.XDG_SESSION_TYPE = original.XDG_SESSION_TYPE;
		process.env.WAYLAND_DISPLAY = original.WAYLAND_DISPLAY;
	});

	it("respects XDG_SESSION_TYPE=wayland", () => {
		process.env.XDG_SESSION_TYPE = "wayland";
		expect(detectLinuxSession()).toBe("wayland");
	});

	it("respects XDG_SESSION_TYPE=x11", () => {
		process.env.XDG_SESSION_TYPE = "x11";
		expect(detectLinuxSession()).toBe("x11");
	});

	it("falls back to WAYLAND_DISPLAY when XDG_SESSION_TYPE is unset", () => {
		delete process.env.XDG_SESSION_TYPE;
		process.env.WAYLAND_DISPLAY = "wayland-0";
		expect(detectLinuxSession()).toBe("wayland");
	});

	it("defaults to x11 when nothing indicates Wayland", () => {
		delete process.env.XDG_SESSION_TYPE;
		delete process.env.WAYLAND_DISPLAY;
		expect(detectLinuxSession()).toBe("x11");
	});
});
