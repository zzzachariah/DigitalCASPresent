"use client";

import { useEffect, useState } from "react";

/** True when the media query matches. Starts false (SSR-safe) and updates
 *  after mount, so only use it for client-side-only branches. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return matches;
}
