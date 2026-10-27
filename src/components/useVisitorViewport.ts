"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { INITIAL_VISITOR_VIEWPORT, measureVisitorViewport } from "@/lib/visitor-viewport";
import type { VisitorViewportVariables } from "@/lib/visitor-viewport";

/** Adapt a mobile fixed shell to the visible viewport without disabling zoom.
 *  Apply `style` to the shell and use its CSS variables for height/top. The
 *  caller supplies question-input focus; desktop leaves all geometry to CSS.
 *  https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport */
export function useVisitorViewport(focused: boolean): {
  style: (CSSProperties & VisitorViewportVariables) | undefined;
  isKeyboardOpen: boolean;
} {
  const [snapshot, setSnapshot] = useState(INITIAL_VISITOR_VIEWPORT);

  useEffect(() => {
    const viewport = window.visualViewport;
    const desktop = window.matchMedia("(min-width: 1024px)");
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const measurement = {
        isMobile: !desktop.matches,
        layoutWidth: window.innerWidth,
        layoutHeight: window.innerHeight,
        visualHeight: viewport?.height,
        visualTop: viewport?.offsetTop,
        scale: viewport?.scale,
        focused,
      };
      setSnapshot((previous) => measureVisitorViewport(previous, measurement));
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    // Keyboard animation, browser chrome and viewport panning can emit many
    // events together. Measure only once in the next animation frame.
    viewport?.addEventListener("resize", schedule, { passive: true });
    viewport?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { passive: true });
    desktop.addEventListener("change", schedule);
    schedule();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      desktop.removeEventListener("change", schedule);
    };
  }, [focused]);

  return { style: snapshot.style, isKeyboardOpen: focused && snapshot.isKeyboardOpen };
}
