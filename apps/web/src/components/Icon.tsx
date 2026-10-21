import type { SVGProps } from 'react';

const paths: Record<string, React.ReactNode> = {
  folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H5.5A2.5 2.5 0 0 1 3 16.5v-9Z" />,
  'folder-plus': (
    <>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H5.5A2.5 2.5 0 0 1 3 16.5v-9Z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L20 20" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="m16 10.5 4.2-2.4a.8.8 0 0 1 1.3.7v6.4a.8.8 0 0 1-1.3.7L16 13.5" />
    </>
  ),
  audio: (
    <>
      <path d="M9 17V6l10-2v11" />
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="16.5" cy="15.5" r="2.5" />
    </>
  ),
  'file-text': (
    <>
      <path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  pdf: (
    <>
      <path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 16.5v-3h1.1a1 1 0 0 1 0 2H8.5m4 1v-3h1a1.5 1.5 0 0 1 0 3h-1Zm4-3h1.5m-1.5 0v3m0-1.5h1.2" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
      <path d="M4.5 8.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5M10 12.5h4" />
    </>
  ),
  code: <path d="m8.5 8-4 4 4 4m7-8 4 4-4 4M13.5 5l-3 14" />,
  file: (
    <>
      <path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8l-5-5Z" />
      <path d="M14 3v5h5" />
    </>
  ),
  sheet: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
      <path d="M4 9.5h16M4 15h16M10 3.5v17" />
    </>
  ),
  presentation: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4m-3 0h6M8 11.5l2.5-2.5 2 2L16 7.5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4m0 0-4 4m4-4 4 4" />
      <path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-2" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12m0 0 4-4m-4 4-4-4" />
      <path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'chevron-left': <path d="m15 5-7 7 7 7" />,
  'chevron-down': <path d="m5 9 7 7 7-7" />,
  'chevron-up': <path d="m5 15 7-7 7 7" />,
  'arrow-left': <path d="M20 12H4m0 0 6-6m-6 6 6 6" />,
  'arrow-right': <path d="M4 12h16m0 0-6-6m6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  trash: <path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7M10 11v6M14 11v6" />,
  pencil: <path d="M4 20h4L20 8a2.1 2.1 0 0 0-3-3L5 17l-1 4Z" />,
  wifi: (
    <>
      <path d="M3 9a15 15 0 0 1 18 0M6 12.5a10.5 10.5 0 0 1 12 0M9 16a5.8 5.8 0 0 1 6 0" />
      <circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M10.5 5.5h3M12 18.2h.01" />
    </>
  ),
  monitor: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
      <path d="M9 21h6M12 17v4" />
    </>
  ),
  refresh: <path d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6" />,
  logout: <path d="M15 4h2.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H15M10 8l-4 4 4 4M6 12h9" />,
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
  sort: <path d="M7 4v16m0 0-3-3m3 3 3-3M13 7h7M13 12h5M13 17h3" />,
  scan: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M4 12h16" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8m-3 3 3 3m-6 0 2.5 2.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 5 6.5v5c0 4 3 7.5 7 9 4-1.5 7-5 7-9v-5l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13h4l1.5 2.5h6L16.5 13h4" />
      <path d="M6 4.5h12a2 2 0 0 1 1.9 1.4L21.5 13v4.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V13l1.6-7.1A2 2 0 0 1 6 4.5Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V13M12 16.5h.01" />
    </>
  ),
  loader: <path d="M12 3a9 9 0 1 0 9 9" />,
  external: <path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
  'cloud-off': (
    <>
      <path d="M7 18h10a4 4 0 0 0 .8-7.9A6 6 0 0 0 7.5 8.2" />
      <path d="M3 3l18 18M12 6a6 6 0 0 1 5.9 4.9" />
    </>
  ),
  zap: <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 6.6M17.5 20a6.4 6.4 0 0 0-2-4.6" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="10.5" rx="2.5" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v2.5" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </>
  ),
};

export type IconName = keyof typeof paths;

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName | string;
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, size = 20, strokeWidth = 1.7, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name] ?? paths.file}
    </svg>
  );
}
