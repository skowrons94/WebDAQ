/**
 * The heading every page starts with: its name, an optional line saying what
 * it is for, and optional actions on the right (wrapping under it on phones).
 * One size and one spacing everywhere, so pages read as one application.
 */
export function PageHeader({ title, description, actions, className = '' }: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={`mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
