export type VisitorViewportVariables = {
  "--visitor-height": string;
  "--visitor-top": string;
};

export interface VisitorViewportMeasurement {
  /** Use the layout media query, never the pinch-zoomed visual width. */
  isMobile: boolean;
  layoutWidth: number;
  layoutHeight: number;
  visualHeight?: number;
  visualTop?: number;
  scale?: number;
  focused: boolean;
}

export interface VisitorViewportSnapshot {
  style: VisitorViewportVariables | undefined;
  isKeyboardOpen: boolean;
  layoutWidth: number;
  baselineHeight: number;
}

/** Also the server/first-client snapshot; no browser globals during render. */
export const INITIAL_VISITOR_VIEWPORT: VisitorViewportSnapshot = {
  style: undefined,
  isKeyboardOpen: false,
  layoutWidth: 0,
  baselineHeight: 0,
};

/** Pure transition logic so keyboard/zoom behaviour can be checked without
 *  pretending a desktop test browser has a real mobile software keyboard. */
export function measureVisitorViewport(
  previous: VisitorViewportSnapshot,
  measurement: VisitorViewportMeasurement,
): VisitorViewportSnapshot {
  if (!measurement.isMobile) return INITIAL_VISITOR_VIEWPORT;

  // Pinch zoom shrinks the visual viewport too. Freeze the last unzoomed
  // geometry rather than making the interface chase the user's zoom/pan.
  // Keep an already-open keyboard state until unzoomed measurement resumes.
  const scale = measurement.scale ?? 1;
  if (!Number.isFinite(scale) || Math.abs(scale - 1) > 0.01) {
    return !measurement.focused && previous.isKeyboardOpen
      ? { ...previous, isKeyboardOpen: false }
      : previous;
  }

  const availableHeight = measurement.visualHeight ?? measurement.layoutHeight;
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return previous;
  const height = Math.round(availableHeight);
  const top = Math.max(0, Math.round(Number.isFinite(measurement.visualTop) ? measurement.visualTop! : 0));
  const layoutHeight = Number.isFinite(measurement.layoutHeight) ? measurement.layoutHeight : height;
  // A rotation or width change starts a new baseline. Keep the largest height
  // at that width so blur while the keyboard animates closed cannot erase it.
  const widthChanged = Math.abs(previous.layoutWidth - measurement.layoutWidth) > 1;
  const baselineHeight = Math.max(height, layoutHeight, widthChanged ? 0 : previous.baselineHeight);
  // A focused input alone (hardware keyboard), browser chrome, or a small
  // address-bar resize must not collapse the visitor's portrait.
  const isKeyboardOpen = measurement.focused && baselineHeight - height > Math.max(120, baselineHeight * 0.18);
  const style = { "--visitor-height": `${height}px`, "--visitor-top": `${top}px` };
  if (previous.style?.["--visitor-height"] === style["--visitor-height"] &&
      previous.style?.["--visitor-top"] === style["--visitor-top"] &&
      previous.isKeyboardOpen === isKeyboardOpen && previous.baselineHeight === baselineHeight &&
      previous.layoutWidth === measurement.layoutWidth) return previous;
  return { style, isKeyboardOpen, baselineHeight, layoutWidth: measurement.layoutWidth };
}
