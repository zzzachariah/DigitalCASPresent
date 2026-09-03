// Small inline icon set (24px grid, 1.75 stroke). No emoji in the UI.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 18, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconArrowRight = (p: P) => (
  <Base {...p}><path d="M5 12h14" /><path d="M13 5l7 7-7 7" /></Base>
);
export const IconArrowLeft = (p: P) => (
  <Base {...p}><path d="M19 12H5" /><path d="M11 19l-7-7 7-7" /></Base>
);
export const IconReplay = (p: P) => (
  <Base {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></Base>
);
export const IconStop = (p: P) => (
  <Base {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></Base>
);
export const IconSearch = (p: P) => (
  <Base {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Base>
);
export const IconPlus = (p: P) => (
  <Base {...p}><path d="M12 5v14" /><path d="M5 12h14" /></Base>
);
export const IconQr = (p: P) => (
  <Base {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 14h3v3" /><path d="M21 14v3" /><path d="M14 21h3" /><path d="M21 21h-1" /></Base>
);
export const IconEdit = (p: P) => (
  <Base {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Base>
);
export const IconTrash = (p: P) => (
  <Base {...p}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></Base>
);
export const IconLink = (p: P) => (
  <Base {...p}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></Base>
);
export const IconCopy = (p: P) => (
  <Base {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></Base>
);
export const IconCheck = (p: P) => (
  <Base {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Base>
);
export const IconEye = (p: P) => (
  <Base {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Base>
);
export const IconUpload = (p: P) => (
  <Base {...p}><path d="M12 16V4" /><path d="M6 10l6-6 6 6" /><path d="M4 20h16" /></Base>
);
export const IconSparkle = (p: P) => (
  <Base {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" /><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z" /></Base>
);
export const IconClose = (p: P) => (
  <Base {...p}><path d="M6 6l12 12" /><path d="M18 6L6 18" /></Base>
);
export const IconUp = (p: P) => (
  <Base {...p}><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></Base>
);
export const IconDown = (p: P) => (
  <Base {...p}><path d="M12 5v14" /><path d="M19 12l-7 7-7-7" /></Base>
);
export const IconChevronDown = (p: P) => (
  <Base {...p}><path d="M6 9l6 6 6-6" /></Base>
);
export const IconExternal = (p: P) => (
  <Base {...p}><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></Base>
);
export const IconWarning = (p: P) => (
  <Base {...p}><path d="M12 3l10 18H2Z" /><path d="M12 10v5" /><path d="M12 18.5h.01" /></Base>
);
export const IconUser = (p: P) => (
  <Base {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></Base>
);
export const IconRefresh = (p: P) => (
  <Base {...p}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></Base>
);
export const IconLogout = (p: P) => (
  <Base {...p}><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /><path d="M13 3h6a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-6" /></Base>
);
export const IconFilm = (p: P) => (
  <Base {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16" /><path d="M17 4v16" /><path d="M3 9h4" /><path d="M3 15h4" /><path d="M17 9h4" /><path d="M17 15h4" /></Base>
);
export const IconImage = (p: P) => (
  <Base {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></Base>
);
export const IconBolt = (p: P) => (
  <Base {...p}><path d="M13 2L4 14h7l-1 8 9-12h-7Z" /></Base>
);
export const IconInbox = (p: P) => (
  <Base {...p}><path d="M3 13l2.5-8h13L21 13" /><path d="M3 13v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6" /><path d="M3 13h5l1.5 3h5L16 13h5" /></Base>
);
export const IconUsers = (p: P) => (
  <Base {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><path d="M18.5 14c2 .8 3 2.6 3 6" /></Base>
);
export const IconMic = (p: P) => (
  <Base {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></Base>
);
