import { describe, expect, it, vi } from "bun:test";
import { FullscreenComposer, type FullscreenComposerOptions } from "../src/modes/fullscreen-composer";

function createFullscreen(overrides: Partial<FullscreenComposerOptions> = {}) {
	let renders = 0;
	let scrollRenders = 0;
	let copied: string | undefined;
	let opened: string | undefined;
	const scrolls: Array<{ delta: number; top: number; bottom: number }> = [];
	const fullscreen = new FullscreenComposer(
		{
			requestRender: () => {
				renders += 1;
			},
			requestScrollRender: () => {
				scrollRenders += 1;
			},
			hintScroll: (delta, top, bottom) => {
				scrolls.push({ delta, top, bottom });
			},
			copySelection: async text => {
				copied = text;
			},
			openUrl: url => {
				opened = url;
			},
			styleJumpToBottom: text => `[${text}]`,
			styleSelection: text => `{${text}}`,
			styleScrollbarThumb: text => text,
			scrollbar: "hidden",
			copyOnSelect: true,
			...overrides,
		},
		true,
	);
	return {
		fullscreen,
		get renders() {
			return renders;
		},
		get scrollRenders() {
			return scrollRenders;
		},
		get copied() {
			return copied;
		},
		get opened() {
			return opened;
		},
		get scrolls() {
			return scrolls;
		},
	};
}

describe("fullscreen composer", () => {
	it("keeps the dock fixed and stops following output after scrolling up", () => {
		const state = createFullscreen();
		const content = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"];
		const first = state.fullscreen.render({ width: 30, height: 5, content, dock: ["editor", "status"] });
		expect(first.map(line => line.trimEnd())).toEqual([" line 4", " line 5", " line 6", "editor", "status"]);

		expect(state.fullscreen.handleInput("\x1b[<64;1;1M")).toBe(true);
		const detached = state.fullscreen.render({ width: 30, height: 5, content, dock: ["editor", "status"] });
		expect(detached[0]?.trimEnd()).toBe(" line 3");
		expect(Bun.stripANSI(detached[2] ?? "")).toContain("Jump to bottom");
		expect(detached.slice(-2)).toEqual(["editor", "status"]);

		const withNewOutput = state.fullscreen.render({
			width: 30,
			height: 5,
			content: [...content, "line 7"],
			dock: ["editor", "status"],
		});
		expect(state.fullscreen.isFollowingOutput).toBe(false);
		expect(withNewOutput[0]?.trimEnd()).toBe(" line 3");
		state.fullscreen.handleInput("\x1b[<0;5;3M");
		const followed = state.fullscreen.render({
			width: 30,
			height: 5,
			content: [...content, "line 7"],
			dock: ["editor", "status"],
		});
		expect(followed.slice(0, 3).map(line => line.trimEnd())).toEqual([" line 5", " line 6", " line 7"]);
		expect(state.fullscreen.isFollowingOutput).toBe(true);
	});

	it("bounds detached terminal scrolling above the fixed jump control", () => {
		const state = createFullscreen();
		const content = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });

		state.fullscreen.handleInput("\x1b[<64;1;1M");
		expect(state.scrolls).toEqual([]);
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });

		state.fullscreen.handleInput("\x1b[<65;1;1M");
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		expect(state.scrollRenders).toBe(2);
		state.fullscreen.render({ width: 30, height: 6, content: [...content, "line 11"], dock: ["editor"] });
		expect(state.scrolls).toEqual([{ delta: 1, top: 0, bottom: 3 }]);
	});

	it("marks both fixed-control rows for repair when the dock height changes", () => {
		const state = createFullscreen();
		const content = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		state.fullscreen.handleInput("\x1b[<64;1;1M");
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		expect(state.fullscreen.forceClearRows).toEqual([4]);

		const changedDock = state.fullscreen.render({
			width: 30,
			height: 6,
			content,
			dock: ["working", "editor"],
		});

		expect(Bun.stripANSI(changedDock[3] ?? "")).toContain("Jump to bottom");
		expect(state.fullscreen.forceClearRows).toEqual([4, 3]);
	});

	it("keeps the fixed control out of repeated slow-scroll paints", () => {
		const state = createFullscreen();
		const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });

		state.fullscreen.handleInput("\x1b[<64;1;1M");
		const detached = state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		const fixedControl = detached[4];
		for (let step = 0; step < 5; step++) {
			state.fullscreen.handleInput("\x1b[<64;1;1M");
			const slowScroll = state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
			expect(slowScroll[4]).toBe(fixedControl);
			expect(state.fullscreen.forceClearRows).toEqual([]);
		}
		expect(state.scrolls).toEqual(Array.from({ length: 5 }, () => ({ delta: -1, top: 0, bottom: 3 })));
	});

	it("repairs the fixed control while a background band crosses its neighboring row", () => {
		const state = createFullscreen();
		const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
		content[8] = `\x1b[48;2;10;30;20m${"Continue".padEnd(28)}\x1b[49m`;
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });

		state.fullscreen.handleInput("\x1b[<64;1;1M");
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		expect(state.fullscreen.forceClearRows).toEqual([4]);

		state.fullscreen.handleInput("\x1b[<64;1;1M");
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		expect(state.fullscreen.forceClearRows).toEqual([4]);

		state.fullscreen.handleInput("\x1b[<64;1;1M");
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		expect(state.fullscreen.forceClearRows).toEqual([4]);

		state.fullscreen.handleInput("\x1b[<64;1;1M");
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		expect(state.fullscreen.forceClearRows).toEqual([]);
	});

	it("ignores horizontal trackpad reports instead of reversing a vertical scroll", () => {
		const state = createFullscreen();
		const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });

		state.fullscreen.handleInput("\x1b[<64;1;1M");
		const afterVertical = state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		expect(state.scrollRenders).toBe(1);

		expect(state.fullscreen.handleInput("\x1b[<67;1;1M")).toBe(true);
		expect(state.scrollRenders).toBe(1);
		expect(state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] })).toEqual(afterVertical);
	});

	it("does not render or hint when scrolling beyond either boundary", () => {
		const state = createFullscreen();
		const content = Array.from({ length: 6 }, (_, index) => `line ${index + 1}`);
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });

		state.fullscreen.handleInput("\x1b[<65;1;1M");
		expect(state.scrollRenders).toBe(0);
		expect(state.scrolls).toEqual([]);

		state.fullscreen.handleInput("\x1b[<64;1;1M");
		state.fullscreen.render({ width: 30, height: 6, content, dock: ["editor"] });
		expect(state.scrollRenders).toBe(1);
		state.fullscreen.handleInput("\x1b[<64;1;1M");
		expect(state.scrollRenders).toBe(1);
		expect(state.scrolls).toEqual([]);
	});

	it("adds a left inset without drawing truncation ellipses beside the scrollbar", () => {
		const state = createFullscreen({ scrollbar: "always" });
		const [line] = state.fullscreen.render({
			width: 12,
			height: 1,
			content: ["abcdefghijkl"],
			dock: [],
		});
		const plain = Bun.stripANSI(line ?? "");

		expect(plain.startsWith(" ")).toBe(true);
		expect(plain).not.toContain("…");
		expect(plain).toHaveLength(12);
	});

	it("shows the auto scrollbar only during recent user scroll activity", () => {
		vi.useFakeTimers();
		try {
			const state = createFullscreen({
				scrollbar: "auto",
				styleScrollbarThumb: text => `\x1b[41m${text}\x1b[49m`,
			});
			const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
			const frame = { width: 12, height: 6, content, dock: [] };

			let rendered = state.fullscreen.render(frame).join("");
			expect(rendered).not.toContain("\x1b[41m");

			state.fullscreen.handleInput("\x1b[<64;1;1M");
			rendered = state.fullscreen.render(frame).join("");
			expect(rendered).toContain("\x1b[41m");

			const rendersBeforeHide = state.renders;
			vi.advanceTimersByTime(1_000);
			expect(state.renders).toBe(rendersBeforeHide + 1);
			rendered = state.fullscreen.render(frame).join("");
			expect(rendered).not.toContain("\x1b[41m");
		} finally {
			vi.useRealTimers();
		}
	});

	it("strips shell-integration zones from fullscreen transcript rows", () => {
		const state = createFullscreen();
		const band = (text: string) => `\x1b[48;2;18;26;22m${text.padEnd(10)}\x1b[49m`;
		const rows = state.fullscreen.render({
			width: 12,
			height: 3,
			content: [`\x1b]133;A\x07${band("")}`, band("Hey"), `${band("")}\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07`],
			dock: [],
		});

		expect(rows.join("")).not.toContain("\x1b]133;");
		expect(rows.map(row => Bun.stringWidth(row, { countAnsiEscapeCodes: false }))).toEqual([12, 12, 12]);
	});

	it("copies a mouse selection on release", () => {
		const state = createFullscreen();
		state.fullscreen.render({ width: 20, height: 2, content: ["alpha", "bravo"], dock: [] });

		state.fullscreen.handleInput("\x1b[<0;3;1M");
		state.fullscreen.handleInput("\x1b[<32;5;1M");
		state.fullscreen.handleInput("\x1b[<0;5;1m");

		expect(state.copied).toBe("lph");
		const selected = state.fullscreen.render({ width: 20, height: 2, content: ["alpha", "bravo"], dock: [] });
		expect(selected[0]?.trimEnd()).toBe(" a{lph}a");
	});

	it("opens an OSC 8 link clicked without dragging", () => {
		const state = createFullscreen();
		const linked = "\x1b]8;;https://example.com\x07example\x1b]8;;\x07";
		state.fullscreen.render({ width: 20, height: 1, content: [linked], dock: [] });

		state.fullscreen.handleInput("\x1b[<0;2;1M");
		state.fullscreen.handleInput("\x1b[<0;2;1m");

		expect(state.opened).toBe("https://example.com");
		expect(state.copied).toBeUndefined();
	});
});
