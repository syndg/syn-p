import type { SgrMouseEvent } from "@oh-my-pi/pi-tui";
import {
	Ellipsis,
	getKeybindings,
	isKeyRelease,
	padding,
	parseSgrMouse,
	sliceByColumn,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

const WHEEL_SCROLL_LINES = 1;
const PAGE_SCROLL_OVERLAP = 4;
const CONTENT_LEFT_INSET = 1;
const CONTENT_RIGHT_INSET = 1;
const ANSI_BACKGROUND_SET_PATTERN = /\x1b\[(?:48;|4[0-7]m|10[0-7]m)/;
const AUTO_SCROLLBAR_HIDE_DELAY_MS = 1_000;
// Shell zones belong to normal-buffer command lines. Syn Pi strips them at its
// fullscreen layout boundary; forwarding them through cmux makes its command
// decoration clip background-filled transcript rows into crooked bands.
const OSC133_SEQUENCE_PATTERN = /\x1b\]133;[^\x07]*\x07/g;

export type TuiMode = "regular" | "fullscreen";
export type FullscreenExitOutput = "transcript" | "resume-hint";
export type FullscreenScrollbar = "auto" | "always" | "hidden";

export interface FullscreenComposerOptions {
	readonly requestRender: () => void;
	readonly requestScrollRender: () => void;
	readonly hintScroll: (delta: number, top: number, bottom: number) => void;
	readonly copySelection: (text: string) => Promise<void>;
	readonly openUrl: (url: string) => void;
	readonly styleJumpToBottom: (text: string) => string;
	readonly styleSelection: (text: string) => string;
	readonly styleScrollbarThumb: (text: string) => string;
	readonly scrollbar: FullscreenScrollbar;
	readonly copyOnSelect: boolean;
}

export interface FullscreenComposerFrame {
	readonly width: number;
	readonly height: number;
	readonly content: readonly string[];
	readonly dock: readonly string[];
}

interface SelectionPoint {
	readonly row: number;
	readonly col: number;
}

interface JumpTarget {
	readonly row: number;
	readonly start: number;
	readonly width: number;
}

interface ScrollbarGeometry {
	readonly start: number;
	readonly end: number;
}

/**
 * Application-owned fullscreen transcript viewport. It hides scrolling,
 * selection, responsive jump affordances, and mouse routing behind the two
 * operations Composer needs: render one frame and intercept viewport input.
 */
export class FullscreenComposer {
	#options: FullscreenComposerOptions;
	#enabled = false;
	#following = true;
	#scrollOffset = 0;
	#viewportHeight = 0;
	#contentWidth = 0;
	#leftInset = 0;
	#rightInset = 0;
	#lastFrameWidth = 0;
	#hasRendered = false;
	#content: readonly string[] = [];
	#selectionAnchor: SelectionPoint | undefined;
	#selectionFocus: SelectionPoint | undefined;
	#selectionPressActive = false;
	#selectionDragged = false;
	#pressedUrl: string | undefined;
	#jumpTarget: JumpTarget | undefined;
	#fixedOverlayRows: readonly number[] = [];
	#jumpNeighborHasBackground = false;
	#transientScrollbarVisible = false;
	#scrollbarHideTimer: NodeJS.Timeout | undefined;

	constructor(options: FullscreenComposerOptions, enabled = false) {
		this.#options = options;
		this.#enabled = enabled;
	}

	setEnabled(enabled: boolean): void {
		if (this.#enabled === enabled) return;
		this.#enabled = enabled;
		this.#selectionPressActive = false;
		this.#pressedUrl = undefined;
		this.#jumpNeighborHasBackground = false;
		this.#hasRendered = false;
		if (!enabled) this.#hideTransientScrollbar();
		this.#options.requestRender();
	}

	setOptions(options: Partial<Pick<FullscreenComposerOptions, "scrollbar" | "copyOnSelect">>): void {
		const previousScrollbar = this.#options.scrollbar;
		this.#options = { ...this.#options, ...options };
		if (this.#options.scrollbar !== previousScrollbar) this.#hideTransientScrollbar();
		this.#options.requestRender();
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	get isFollowingOutput(): boolean {
		return this.#following;
	}

	/** Viewport rows whose fixed overlays must bypass differential-paint caching. */
	get forceClearRows(): readonly number[] {
		return this.#fixedOverlayRows;
	}

	contentWidth(frameWidth: number): number {
		const width = Math.max(1, Math.trunc(frameWidth));
		const leftInset = width > 1 ? CONTENT_LEFT_INSET : 0;
		const rightInset = width > 2 ? CONTENT_RIGHT_INSET : 0;
		return Math.max(1, width - leftInset - rightInset);
	}

	render(frame: FullscreenComposerFrame): readonly string[] {
		const width = Math.max(1, Math.trunc(frame.width));
		const height = Math.max(0, Math.trunc(frame.height));
		const previousJumpRow = this.#jumpTarget?.row;
		const previousJumpNeighborHasBackground = this.#jumpNeighborHasBackground;
		const previousOffset = this.#scrollOffset;
		const previousViewportHeight = this.#viewportHeight;
		const dock = frame.dock.length > height ? frame.dock.slice(frame.dock.length - height) : frame.dock;
		const availableViewportHeight = Math.max(0, height - dock.length);
		this.#viewportHeight = Math.max(0, availableViewportHeight - (this.#following ? 0 : 1));
		this.#content = frame.content;
		this.#leftInset = width > 1 ? CONTENT_LEFT_INSET : 0;
		this.#rightInset = width > 2 ? CONTENT_RIGHT_INSET : 0;
		this.#contentWidth = this.contentWidth(width);
		if (this.#content.length <= this.#viewportHeight) this.#hideTransientScrollbar();
		const showScrollbar = this.#rightInset > 0 && this.#shouldShowScrollbar();

		const maxOffset = this.#maxScrollOffset();
		if (this.#following) this.#scrollOffset = maxOffset;
		else this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxOffset));
		if (this.#hasRendered && this.#lastFrameWidth === width && previousViewportHeight === this.#viewportHeight) {
			this.#hintScroll(this.#scrollOffset - previousOffset, this.#following);
		}

		const viewport: string[] = [];
		for (let row = 0; row < this.#viewportHeight; row++) {
			const documentRow = this.#scrollOffset + row;
			const source = this.#applySelection(frame.content[documentRow] ?? "", documentRow);
			viewport.push(this.#frameContentLine(source, width));
		}
		if (showScrollbar) this.#appendScrollbar(viewport);
		if (!this.#following && availableViewportHeight > 0) {
			viewport.push(this.#frameContentLine("", width));
		}

		this.#jumpTarget = this.#following ? undefined : this.#compositeJumpToBottom(viewport);
		const currentJumpRow = this.#jumpTarget?.row;
		const currentJumpNeighborHasBackground =
			currentJumpRow !== undefined &&
			currentJumpRow > 0 &&
			ANSI_BACKGROUND_SET_PATTERN.test(viewport[currentJumpRow - 1] ?? "");
		let fixedOverlayRows: readonly number[] =
			previousJumpRow === currentJumpRow
				? []
				: previousJumpRow === undefined
					? currentJumpRow === undefined
						? []
						: [currentJumpRow]
					: currentJumpRow === undefined
						? [previousJumpRow]
						: [previousJumpRow, currentJumpRow];
		if (
			currentJumpRow !== undefined &&
			(previousJumpNeighborHasBackground || currentJumpNeighborHasBackground) &&
			!fixedOverlayRows.includes(currentJumpRow)
		) {
			fixedOverlayRows = [...fixedOverlayRows, currentJumpRow];
		}
		this.#fixedOverlayRows = fixedOverlayRows;
		this.#jumpNeighborHasBackground = currentJumpNeighborHasBackground;
		this.#lastFrameWidth = width;
		this.#hasRendered = true;
		return [...viewport, ...dock];
	}

	#frameContentLine(source: string, width: number): string {
		if (TERMINAL.isImageLine(source)) return source;
		source = source.replace(OSC133_SEQUENCE_PATTERN, "");
		const content = truncateToWidth(source, this.#contentWidth, Ellipsis.Omit);
		const contentPadding = padding(Math.max(0, this.#contentWidth - visibleWidth(content)));
		const left = padding(this.#leftInset);
		const right = padding(this.#rightInset);
		return truncateToWidth(`${left}${content}${contentPadding}${right}`, width, Ellipsis.Omit);
	}

	handleInput(data: string): boolean {
		if (!this.#enabled) return false;
		const mouse = parseSgrMouse(data);
		if (mouse) {
			this.#handleMouse(mouse);
			return true;
		}
		if (isKeyRelease(data)) return false;
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.transcript.pageUp")) {
			this.#scrollBy(-Math.max(1, this.#viewportHeight - PAGE_SCROLL_OVERLAP));
			return true;
		}
		if (keybindings.matches(data, "app.transcript.pageDown")) {
			this.#scrollBy(Math.max(1, this.#viewportHeight - PAGE_SCROLL_OVERLAP));
			return true;
		}
		if (keybindings.matches(data, "app.transcript.halfPageUp")) {
			this.#scrollBy(-Math.max(1, Math.floor(this.#viewportHeight / 2)));
			return true;
		}
		if (keybindings.matches(data, "app.transcript.halfPageDown")) {
			this.#scrollBy(Math.max(1, Math.floor(this.#viewportHeight / 2)));
			return true;
		}
		if (keybindings.matches(data, "app.transcript.lineUp")) {
			this.#scrollBy(-1);
			return true;
		}
		if (keybindings.matches(data, "app.transcript.lineDown")) {
			this.#scrollBy(1);
			return true;
		}
		if (keybindings.matches(data, "app.transcript.top")) {
			this.#scrollTo(0);
			return true;
		}
		if (keybindings.matches(data, "app.transcript.bottom")) {
			this.#scrollToBottom();
			return true;
		}
		return false;
	}

	getSelectionText(): string | undefined {
		const selection = this.#selectionBounds();
		if (!selection) return undefined;
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = this.#content[row] ?? "";
			const lineWidth = visibleWidth(line);
			const start = row === selection.start.row ? Math.min(selection.start.col, lineWidth) : 0;
			const end = row === selection.end.row ? Math.min(selection.end.col + 1, lineWidth) : lineWidth;
			lines.push(Bun.stripANSI(sliceByColumn(line, start, Math.max(0, end - start), true)).trimEnd());
		}
		const text = lines.join("\n");
		return text.length > 0 ? text : undefined;
	}

	#handleMouse(event: SgrMouseEvent): void {
		if (event.wheel !== null) {
			this.#scrollBy(event.wheel * WHEEL_SCROLL_LINES);
			return;
		}
		if (event.leftClick && this.#isJumpTarget(event.row, event.col)) {
			this.#clearSelection();
			this.#scrollToBottom();
			return;
		}
		if (event.row < 0 || event.row >= this.#viewportHeight || this.#viewportHeight === 0) return;
		const point = this.#selectionPoint(event.row, event.col);
		if (!point) return;
		if (event.release) {
			if (!this.#selectionPressActive) return;
			this.#selectionPressActive = false;
			this.#selectionFocus = point;
			const clickedUrl =
				!this.#selectionDragged && this.#samePoint(this.#selectionAnchor, point) ? this.#pressedUrl : undefined;
			this.#pressedUrl = undefined;
			if (clickedUrl) {
				this.#clearSelection();
				this.#options.openUrl(clickedUrl);
			} else if (this.#options.copyOnSelect) {
				const text = this.getSelectionText();
				if (text) void this.#options.copySelection(text);
			}
			this.#options.requestRender();
			return;
		}
		if (event.motion) {
			if (!this.#selectionPressActive || (event.button & 3) !== 0) return;
			this.#selectionDragged = true;
			this.#pressedUrl = undefined;
			this.#selectionFocus = point;
			this.#options.requestRender();
			return;
		}
		if (!event.leftClick) return;
		this.#selectionPressActive = true;
		this.#selectionDragged = false;
		this.#selectionAnchor = point;
		this.#selectionFocus = point;
		this.#pressedUrl = this.#osc8LinkAtColumn(this.#content[point.row] ?? "", point.col);
		this.#options.requestRender();
	}

	#selectionPoint(viewportRow: number, col: number): SelectionPoint | undefined {
		const row = this.#scrollOffset + viewportRow;
		if (row < 0 || row >= this.#content.length) return undefined;
		return { row, col: Math.max(0, Math.min(col - this.#leftInset, this.#contentWidth - 1)) };
	}

	#selectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		const anchor = this.#selectionAnchor;
		const focus = this.#selectionFocus;
		if (!anchor || !focus || this.#samePoint(anchor, focus)) return undefined;
		return anchor.row < focus.row || (anchor.row === focus.row && anchor.col < focus.col)
			? { start: anchor, end: focus }
			: { start: focus, end: anchor };
	}

	#samePoint(left: SelectionPoint | undefined, right: SelectionPoint | undefined): boolean {
		return left?.row === right?.row && left?.col === right?.col;
	}

	#clearSelection(): void {
		this.#selectionAnchor = undefined;
		this.#selectionFocus = undefined;
		this.#selectionPressActive = false;
		this.#selectionDragged = false;
		this.#pressedUrl = undefined;
	}

	#applySelection(line: string, documentRow: number): string {
		const selection = this.#selectionBounds();
		if (
			!selection ||
			documentRow < selection.start.row ||
			documentRow > selection.end.row ||
			TERMINAL.isImageLine(line)
		) {
			return line;
		}
		const lineWidth = visibleWidth(line);
		const start = documentRow === selection.start.row ? Math.min(selection.start.col, lineWidth) : 0;
		const end = documentRow === selection.end.row ? Math.min(selection.end.col + 1, lineWidth) : lineWidth;
		if (end <= start) return line;
		const before = sliceByColumn(line, 0, start, true);
		const selected = sliceByColumn(line, start, end - start, true);
		const after = sliceByColumn(line, end, Math.max(0, lineWidth - end), true);
		return `${before}${this.#options.styleSelection(selected)}${after}`;
	}

	#scrollBy(delta: number): void {
		this.#scrollTo(this.#scrollOffset + delta);
	}

	#scrollTo(offset: number): void {
		const previousOffset = this.#scrollOffset;
		const previousFollowing = this.#following;
		const maxOffset = this.#maxScrollOffset();
		const nextOffset = Math.max(0, Math.min(Math.trunc(offset), maxOffset));
		const nextFollowing = nextOffset === maxOffset;
		if (nextOffset === previousOffset && nextFollowing === previousFollowing) return;
		this.#scrollOffset = nextOffset;
		this.#following = nextFollowing;
		if (nextOffset !== previousOffset) this.#markScrollbarActivity();
		this.#hintScroll(nextOffset - previousOffset, previousFollowing === nextFollowing);
		this.#options.requestScrollRender();
	}

	#scrollToBottom(): void {
		const previousOffset = this.#scrollOffset;
		const previousFollowing = this.#following;
		this.#following = true;
		this.#scrollOffset = this.#maxScrollOffset();
		if (this.#scrollOffset !== previousOffset || !previousFollowing) this.#markScrollbarActivity();
		this.#hintScroll(this.#scrollOffset - previousOffset, previousFollowing && this.#following);
		this.#options.requestScrollRender();
	}

	#hintScroll(delta: number, fixedOverlayFree: boolean): void {
		// Stable followed/detached states keep fixed UI outside this transcript
		// region. State transitions skip the hint and repaint their changed rows.
		if (fixedOverlayFree && delta !== 0 && this.#viewportHeight > 1) {
			this.#options.hintScroll(delta, 0, this.#viewportHeight - 1);
		}
	}

	#maxScrollOffset(): number {
		return Math.max(0, this.#content.length - this.#viewportHeight);
	}

	#shouldShowScrollbar(): boolean {
		if (this.#options.scrollbar === "hidden") return false;
		if (this.#options.scrollbar === "always") return this.#viewportHeight > 0;
		return this.#content.length > this.#viewportHeight && this.#viewportHeight > 0 && this.#transientScrollbarVisible;
	}

	#markScrollbarActivity(): void {
		if (this.#options.scrollbar !== "auto" || this.#content.length <= this.#viewportHeight) return;
		this.#transientScrollbarVisible = true;
		clearTimeout(this.#scrollbarHideTimer);
		this.#scrollbarHideTimer = setTimeout(() => {
			this.#scrollbarHideTimer = undefined;
			this.#transientScrollbarVisible = false;
			this.#options.requestRender();
		}, AUTO_SCROLLBAR_HIDE_DELAY_MS);
		this.#scrollbarHideTimer.unref();
	}

	#hideTransientScrollbar(): void {
		this.#transientScrollbarVisible = false;
		clearTimeout(this.#scrollbarHideTimer);
		this.#scrollbarHideTimer = undefined;
	}

	#scrollbarGeometry(): ScrollbarGeometry | undefined {
		if (this.#viewportHeight <= 0 || this.#content.length <= 0) return undefined;
		const thumbSize = Math.max(1, Math.floor((this.#viewportHeight * this.#viewportHeight) / this.#content.length));
		const travel = Math.max(0, this.#viewportHeight - thumbSize);
		const maxOffset = this.#maxScrollOffset();
		const start = maxOffset === 0 ? 0 : Math.round((this.#scrollOffset / maxOffset) * travel);
		return { start, end: start + thumbSize };
	}

	#appendScrollbar(viewport: string[]): void {
		const thumb = this.#scrollbarGeometry();
		if (!thumb) return;
		const scrollbarColumn = this.#leftInset + this.#contentWidth;
		for (let row = thumb.start; row < Math.min(thumb.end, viewport.length); row++) {
			const source = viewport[row] ?? "";
			if (TERMINAL.isImageLine(source)) continue;
			viewport[row] = sliceByColumn(source, 0, scrollbarColumn, true) + this.#options.styleScrollbarThumb(" ");
		}
	}

	#compositeJumpToBottom(viewport: string[]): JumpTarget | undefined {
		if (viewport.length === 0) return undefined;
		const row = viewport.length - 1;
		const source = viewport[row] ?? "";
		if (TERMINAL.isImageLine(source)) return undefined;
		const availableWidth = this.#contentWidth;
		const full = " Jump to bottom (click) ↓ ";
		const medium = " Jump to bottom ↓ ";
		const compact = "↓ bottom";
		const text =
			availableWidth >= visibleWidth(full)
				? full
				: availableWidth >= visibleWidth(medium)
					? medium
					: availableWidth >= visibleWidth(compact)
						? compact
						: "↓";
		const textWidth = visibleWidth(text);
		const start = this.#leftInset + Math.max(0, Math.floor((availableWidth - textWidth) / 2));
		const sourceWidth = visibleWidth(source);
		const before = sliceByColumn(source, 0, start, true);
		const afterStart = start + textWidth;
		const after = sliceByColumn(source, afterStart, Math.max(0, sourceWidth - afterStart), true);
		viewport[row] =
			`${before}${padding(Math.max(0, start - visibleWidth(before)))}${this.#options.styleJumpToBottom(text)}${after}`;
		return { row, start, width: textWidth };
	}

	#isJumpTarget(row: number, col: number): boolean {
		const target = this.#jumpTarget;
		return Boolean(target && row === target.row && col >= target.start && col < target.start + target.width);
	}

	#osc8LinkAtColumn(line: string, column: number): string | undefined {
		const pattern = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
		let activeUrl: string | undefined;
		let currentColumn = 0;
		let previousEnd = 0;
		for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
			const spanWidth = visibleWidth(line.slice(previousEnd, match.index));
			if (column >= currentColumn && column < currentColumn + spanWidth) return activeUrl;
			currentColumn += spanWidth;
			activeUrl = match[1] || undefined;
			previousEnd = pattern.lastIndex;
		}
		const tailWidth = visibleWidth(line.slice(previousEnd));
		return column >= currentColumn && column < currentColumn + tailWidth ? activeUrl : undefined;
	}
}
