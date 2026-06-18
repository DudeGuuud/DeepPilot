type DeepPilotLogoMarkProps = {
  className?: string;
};

export function DeepPilotLogoMark({ className }: DeepPilotLogoMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0.5" y="0.5" width="47" height="47" rx="9.5" fill="#09090b" />
      <rect x="0.5" y="0.5" width="47" height="47" rx="9.5" stroke="#27272a" />
      <path
        d="M16 12H24.5C31.5 12 37 17.25 37 24C37 30.75 31.5 36 24.5 36H16V12Z"
        stroke="#fafafa"
        strokeLinejoin="round"
        strokeWidth="3.6"
      />
      <path d="M22 17.5L30.5 24L22 30.5" stroke="#34d399" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.6" />
    </svg>
  );
}
