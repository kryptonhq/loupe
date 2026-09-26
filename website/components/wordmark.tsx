export function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      {/* The app's own aperture mark — same geometry as app/icon.svg: six
          blades closing onto a hexagon. */}
      <svg viewBox="0 0 200 200" className="size-5" aria-hidden="true">
        {/* No <mask>: the layout renders this twice (desktop and mobile
            nav), and a duplicated mask id breaks whichever copy is not
            first. Painting the hexagon over the disc gives the same shape. */}
        <rect width="200" height="200" rx="46" ry="46" fill="var(--color-loupe-indigo)" />
        <circle cx="100" cy="100" r="68" fill="#fff" />
        <polygon
          points="100,60 134.64,80 134.64,120 100,140 65.36,120 65.36,80"
          fill="var(--color-loupe-indigo)"
        />
        <g stroke="var(--color-loupe-indigo)" strokeWidth="7" strokeLinecap="round">
          <line x1="100" y1="60" x2="123.26" y2="36.1" />
          <line x1="134.64" y1="80" x2="166.97" y2="88.19" />
          <line x1="134.64" y1="120" x2="143.71" y2="152.09" />
          <line x1="100" y1="140" x2="76.74" y2="163.9" />
          <line x1="65.36" y1="120" x2="33.03" y2="111.81" />
          <line x1="65.36" y1="80" x2="56.29" y2="47.91" />
        </g>
        <circle cx="100" cy="100" r="11" fill="#fff" />
      </svg>
      <span className="font-semibold tracking-tight">Loupe</span>
    </span>
  );
}
