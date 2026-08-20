/** The Marginalia mark: a margin rule with notes beside it. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label="Marginalia"
      fill="none"
    >
      <rect width="100" height="100" rx="22" className="fill-foreground" />
      <rect
        x="26.9"
        y="23"
        width="5"
        height="54"
        rx="2.5"
        className="fill-accent-foreground"
      />
      <rect x="38.4" y="30.9" width="40.5" height="5.1" rx="2.6" className="fill-background" />
      <rect x="38.4" y="44.2" width="32.4" height="5.1" rx="2.6" className="fill-background" />
      <rect x="38.4" y="57.5" width="22.3" height="5.1" rx="2.6" className="fill-background" />
    </svg>
  )
}
