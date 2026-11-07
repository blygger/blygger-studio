/*
 * The studio's line icons: 24-unit grid, 1.75 stroke, `currentColor`, so a
 * button's colour (muted at rest, the accent when on) is the icon's colour.
 * Decorative only (aria-hidden): every button that shows one keeps its
 * existing words as its accessible name and its title.
 */
import type { ReactNode, SVGProps } from 'react';

function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      className="ico"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}
export const ThumbUp = () => (
  <Svg>
    <path className="fillable" d="M7 10v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3Zm0 0 4-7a2.5 2.5 0 0 1 2.5 3L13 9h5.5a2 2 0 0 1 2 2.4l-1.3 6.6a2.5 2.5 0 0 1-2.5 2H7" />
  </Svg>
);
export const ThumbDown = () => (
  <Svg>
    <path className="fillable" d="M17 14V4h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3Zm0 0-4 7a2.5 2.5 0 0 1-2.5-3L11 15H5.5a2 2 0 0 1-2-2.4l1.3-6.6a2.5 2.5 0 0 1 2.5-2H17" />
  </Svg>
);
export const More = () => (
  <Svg strokeWidth="2.5">
    <path d="M5 12h.01M12 12h.01M19 12h.01" />
  </Svg>
);
export const Image = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m21 16-5-5-9 9" />
  </Svg>
);
export const LinkIcon = () => (
  <Svg>
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
  </Svg>
);
export const Scan = () => (
  <Svg>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <path d="M8 9h8M8 12h8M8 15h5" />
  </Svg>
);
export const Sparkle = () => (
  <Svg>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
  </Svg>
);
export const EnterFocus = () => (
  <Svg>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);
export const ExitFocus = () => (
  <Svg>
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </Svg>
);
export const Swap = () => (
  <Svg>
    <path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8" />
  </Svg>
);
export const Expand = () => (
  <Svg>
    <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
  </Svg>
);
export const Back = () => (
  <Svg>
    <path d="m15 5-7 7 7 7" />
  </Svg>
);
export const Reply = () => (
  <Svg>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);
export const Tray = () => (
  <Svg>
    <path d="M3 13h5l1.5 3h5L16 13h5" />
    <path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2.5-8Z" />
  </Svg>
);
export const Pencil = () => (
  <Svg>
    <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />
  </Svg>
);
