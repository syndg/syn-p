import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";

describe("--tui-mode", () => {
	it("parses fullscreen without leaking it into the prompt", () => {
		const parsed = parseArgs(["--tui-mode", "fullscreen", "continue here"]);
		expect(parsed.tuiMode).toBe("fullscreen");
		expect(parsed.messages).toEqual(["continue here"]);
	});

	it("accepts an explicit regular override", () => {
		expect(parseArgs(["--tui-mode=regular"]).tuiMode).toBe("regular");
	});

	it("rejects unknown modes", () => {
		expect(() => parseArgs(["--tui-mode", "floating"])).toThrow(
			'Invalid --tui-mode value: "floating". Expected one of: regular, fullscreen.',
		);
	});
});
