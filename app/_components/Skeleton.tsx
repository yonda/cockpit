export function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="h-4 w-40 animate-pulse bg-[var(--hairline-strong)]" />
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-36 animate-pulse border border-[var(--hairline)] bg-[var(--panel)]"
          />
        ))}
      </div>
    </div>
  );
}
