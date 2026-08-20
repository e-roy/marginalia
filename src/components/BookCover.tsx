import { cn } from '@/lib/utils'

interface BookCoverProps {
  title: string
  coverUrl: string | null
  className?: string
}

/**
 * A cover, or a legible stand-in for one.
 *
 * Most books added by hand will never have artwork, and a broken-image icon in a strip
 * of covers reads as a bug. The fallback is the book's own initial on a plain card —
 * recognisable enough to tell four books apart at a glance, which is all the strip
 * needs.
 */
export function BookCover({ title, coverUrl, className }: BookCoverProps) {
  const initial = title.trim().charAt(0).toUpperCase() || '?'

  return (
    <div
      className={cn(
        'bg-muted text-muted-foreground relative aspect-[2/3] w-full shrink-0 overflow-hidden rounded-md',
        className,
      )}
    >
      {/* Sits underneath, so it shows through whenever the image is missing, still
          loading, or failed — no error handler and no state needed. */}
      <span
        aria-hidden
        className="absolute inset-0 flex items-center justify-center text-lg font-semibold"
      >
        {initial}
      </span>

      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          // Covers come from a third party and the phone is often offline. Hiding a
          // failed image outright is surer than relying on an empty `alt` to collapse
          // it, and uncovers the initial underneath.
          onError={(event) => {
            event.currentTarget.hidden = true
          }}
          className="relative h-full w-full object-cover"
        />
      ) : null}
    </div>
  )
}
