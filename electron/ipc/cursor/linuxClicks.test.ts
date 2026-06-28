import { describe, expect, it } from "vitest";
import { parseLibinputButtonLine } from "./linuxClicks";

describe("parseLibinputButtonLine", () => {
	it("parses a left-button press (real libinput line)", () => {
		const line = " event6   POINTER_BUTTON   +7.005s\tBTN_LEFT (272) pressed, seat count: 1";
		expect(parseLibinputButtonLine(line)).toEqual({ button: 1, pressed: true });
	});

	it("parses a release", () => {
		const line = " event6   POINTER_BUTTON   +7.1s\tBTN_LEFT (272) released, seat count: 0";
		expect(parseLibinputButtonLine(line)).toEqual({ button: 1, pressed: false });
	});

	it("maps right and middle buttons", () => {
		expect(parseLibinputButtonLine("x POINTER_BUTTON BTN_RIGHT (273) pressed")?.button).toBe(2);
		expect(parseLibinputButtonLine("x POINTER_BUTTON BTN_MIDDLE (274) pressed")?.button).toBe(3);
	});

	it("ignores motion and other lines", () => {
		expect(parseLibinputButtonLine(" event6 POINTER_MOTION +1.2s 1.5/-0.5")).toBeNull();
		expect(parseLibinputButtonLine(" event6 DEVICE_ADDED Touchpad")).toBeNull();
	});
});
