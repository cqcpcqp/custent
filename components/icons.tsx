import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {children}
    </svg>
  );
}

export function BrandMark(props: IconProps) {
  return (
    <IconBase {...props} viewBox="0 0 32 32">
      <path
        d="M5.3 20.7c3.7-.4 6.9-2.7 8.6-6.1 1.4-2.9 4.5-4.7 7.7-4.5l5.1.3-2.3 4.5a11.6 11.6 0 0 1-10.6 6.4H5.3v-.6Z"
        fill="currentColor"
      />
      <path
        d="M7 25.4c4.8-1.6 8.5-5.3 10.2-10.1"
        stroke="white"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="m13.5 7.1 1.4-2.8 1.5 2.8 3.1.5-2.3 2.2.6 3.1-2.9-1.5-2.8 1.5.5-3.1-2.2-2.2 3.1-.5Z"
        fill="currentColor"
        opacity=".72"
      />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function AttachmentIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m9.2 12.8 5.9-5.9a3 3 0 0 1 4.2 4.2l-7.8 7.8a5 5 0 0 1-7.1-7.1l7.3-7.3a2.9 2.9 0 0 1 4.1 4.1l-6.7 6.7a1 1 0 0 1-1.4-1.4l6.1-6.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </IconBase>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect
        height="15"
        rx="2.4"
        stroke="currentColor"
        strokeWidth="1.55"
        width="17"
        x="3.5"
        y="4.5"
      />
      <circle cx="9" cy="9.3" r="1.6" fill="currentColor" />
      <path
        d="m5.5 17 4.2-4.2 2.7 2.7 2.2-2.2 3.9 3.9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
    </IconBase>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M5.7 18.3 4.5 21l3.2-1.3c1.2.6 2.7.9 4.3.9 4.8 0 8.7-3.6 8.7-8.1S16.8 4.4 12 4.4s-8.7 3.6-8.7 8.1c0 2.2.9 4.2 2.4 5.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </IconBase>
  );
}

export function KeyboardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect
        height="13"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.55"
        width="18"
        x="3"
        y="5.5"
      />
      <path
        d="M6 9h.01M9 9h.01M12 9h.01M15 9h.01M18 9h.01M6 12.3h.01M9 12.3h.01M12 12.3h.01M15 12.3h.01M18 12.3h.01M7.5 15.5h9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </IconBase>
  );
}

export function CoinsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <ellipse cx="9" cy="7" rx="5.5" ry="2.7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 7v4c0 1.5 2.5 2.7 5.5 2.7s5.5-1.2 5.5-2.7V7M3.5 11v4c0 1.5 2.5 2.7 5.5 2.7 1.2 0 2.3-.2 3.2-.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13.8 13.2h6.7v5.1a2.3 2.3 0 0 1-2.3 2.3h-2.1a2.3 2.3 0 0 1-2.3-2.3v-5.1Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
      <path d="M15.6 13.2v-1a1.6 1.6 0 0 1 3.2 0v1" stroke="currentColor" strokeWidth="1.5" />
    </IconBase>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="10.7" cy="10.7" r="5.8" stroke="currentColor" strokeWidth="1.7" />
      <path d="m15.1 15.1 4.2 4.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </IconBase>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="5" cy="12" fill="currentColor" r="1.5" />
      <circle cx="12" cy="12" fill="currentColor" r="1.5" />
      <circle cx="19" cy="12" fill="currentColor" r="1.5" />
    </IconBase>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m8 4 8 8m-6.6-6.6L6.7 8.1l2.6 2.6-4.8 4.8 4 4 4.8-4.8 2.6 2.6 2.7-2.7M4.5 19.5l-1 1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
    </IconBase>
  );
}

export function ArchiveIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M4.5 8h15v11h-15V8Zm-1-4h17v4h-17V4Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
      <path d="M9 12h6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.55" />
    </IconBase>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M5.5 7.5h13M9 4.5h6l1 3H8l1-3Zm-1.5 3 1 12h7l1-12M10 11v5m4-5v5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
    </IconBase>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m14.7 5.3 4 4M5 19l1.2-4.7L15.5 5a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5l-9.3 9.3L5 19Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
    </IconBase>
  );
}

export function RestoreIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M5 8V4m0 0h4M5 4l3.2 3.2A7.5 7.5 0 1 1 4.8 13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.65"
      />
    </IconBase>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.8 12h16.4M12 3.5c2.1 2.3 3.2 5.1 3.2 8.5S14.1 18.2 12 20.5C9.9 18.2 8.8 15.4 8.8 12S9.9 5.8 12 3.5Z" stroke="currentColor" strokeWidth="1.5" />
    </IconBase>
  );
}

export function PeopleIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.6 18.5v-.9A4.6 4.6 0 0 1 8.2 13h1.6a4.6 4.6 0 0 1 4.6 4.6v.9" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path d="M15 5.4a3 3 0 0 1 0 5.5M16.2 13.2a4.6 4.6 0 0 1 4.2 4.6v.7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </IconBase>
  );
}

export function ChartIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 19V9m7 10V5m7 14v-7" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M3.5 19.5h17" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </IconBase>
  );
}

export function DocumentIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 3.5h8l4 4v13H6v-17Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
      <path d="M14 3.5v4h4M9 12h6M9 16h6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </IconBase>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m8.3 7.2-4.8 4.8 4.8 4.8M15.7 7.2l4.8 4.8-4.8 4.8M13.7 4.8l-3.4 14.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.65"
      />
    </IconBase>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m7 11 5-5 5 5M12 6v12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </IconBase>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1.8" fill="currentColor" />
    </IconBase>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M13 5h6v6M19 5l-8 8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
      <path d="M17 14v4.5H5.5v-11H10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </IconBase>
  );
}

export function ShareIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M12 15V4m0 0L8 8m4-4 4 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M7 10H5.5A1.5 1.5 0 0 0 4 11.5v7A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </IconBase>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19.5h14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </IconBase>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect
        height="11"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
        width="11"
        x="8"
        y="8"
      />
      <path
        d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </IconBase>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="6" cy="5" fill="currentColor" r="1.8" />
      <circle cx="18" cy="5" fill="currentColor" r="1.8" />
      <circle cx="18" cy="19" fill="currentColor" r="1.8" />
      <path
        d="M6 6.8v5.1A3.1 3.1 0 0 0 9.1 15H13a5 5 0 0 0 5-5V6.8M13 15h1a4 4 0 0 1 4 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
    </IconBase>
  );
}

export function ThumbsUpIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M8.5 10.25 11.75 4a2 2 0 0 1 1.75 2.95l-.8 2.3h4.55a2 2 0 0 1 1.93 2.53l-1.55 5.7A2 2 0 0 1 15.7 19H8.5m0-8.75V19H4.75a1 1 0 0 1-1-1v-6.75a1 1 0 0 1 1-1H8.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
    </IconBase>
  );
}

export function ThumbsDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="rotate(180 12 12)">
        <path
          d="M8.5 10.25 11.75 4a2 2 0 0 1 1.75 2.95l-.8 2.3h4.55a2 2 0 0 1 1.93 2.53l-1.55 5.7A2 2 0 0 1 15.7 19H8.5m0-8.75V19H4.75a1 1 0 0 1-1-1v-6.75a1 1 0 0 1 1-1H8.5Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.55"
        />
      </g>
    </IconBase>
  );
}

export function SparklesIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9.5 3.5c.5 3.4 2.3 5.2 5.7 5.7-3.4.5-5.2 2.3-5.7 5.7-.5-3.4-2.3-5.2-5.7-5.7 3.4-.5 5.2-2.3 5.7-5.7Z" fill="currentColor" />
      <path d="M17.3 13.5c.3 2 1.4 3.1 3.4 3.4-2 .3-3.1 1.4-3.4 3.4-.3-2-1.4-3.1-3.4-3.4 2-.3 3.1-1.4 3.4-3.4Z" fill="currentColor" opacity=".72" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5.5 12.5 4 4 9-9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
    </IconBase>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3.6" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </IconBase>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M19.2 15.2A7.7 7.7 0 0 1 8.8 4.8 7.7 7.7 0 1 0 19.2 15.2Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </IconBase>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect
        height="11.5"
        rx="1.8"
        stroke="currentColor"
        strokeWidth="1.55"
        width="17"
        x="3.5"
        y="4.5"
      />
      <path
        d="M9 20h6M12 16v4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.55"
      />
    </IconBase>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M9.7 3.8h4.6l.6 2.1c.4.2.8.4 1.2.7l2.1-.6 2.3 4-1.6 1.5v1.3l1.6 1.5-2.3 4-2.1-.6c-.4.3-.8.5-1.2.7l-.6 2.1H9.7l-.6-2.1c-.4-.2-.8-.4-1.2-.7l-2.1.6-2.3-4 1.6-1.5v-1.3L3.5 10l2.3-4 2.1.6c.4-.3.8-.5 1.2-.7l.6-2.1Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
    </IconBase>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m12 3.5 9 16H3l9-16Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
      <path d="M12 9v4.5M12 17h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M19 7.5A8 8 0 1 0 20 15M19 4v3.5h-3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </IconBase>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M5 18.5V15m4.7 3.5V10m4.6 8.5V5.5m4.7 13V8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </IconBase>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m6.5 9.5 5.5 5 5.5-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </IconBase>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m14.5 6.5-5 5.5 5 5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </IconBase>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="m9.5 6.5 5 5.5-5 5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </IconBase>
  );
}
