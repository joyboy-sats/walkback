import type { PricePath } from "@/lib/feed-present";

/**
 * Stored deciding-candle prints against the target.
 * The caller only passes a path with at least two points. Nothing is interpolated.
 */
export function PriceChart({
  path,
  label,
}: {
  path: PricePath;
  label: string;
}) {
  const width = 440;
  const height = 148;
  const padX = 12;
  const padY = 16;
  const values = path.points.map((point) => point.value);
  if (path.target !== null) values.push(path.target);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) =>
    padX + (index / Math.max(path.points.length - 1, 1)) * (width - padX * 2);
  const y = (value: number) => padY + (1 - (value - min) / span) * (height - padY * 2);
  const line = path.points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`)
    .join(" ");
  const targetY = path.target === null ? null : y(path.target);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      className="mt-3 h-[148px] w-full max-w-[440px]"
    >
      {targetY !== null && (
        <line
          x1={padX}
          x2={width - padX}
          y1={targetY}
          y2={targetY}
          stroke="currentColor"
          strokeDasharray="4 4"
          className="text-ink-3"
        />
      )}
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink" />
      {path.points.map((point, index) => (
        <circle key={point.at} cx={x(index)} cy={y(point.value)} r="2.5" className="fill-ink" />
      ))}
    </svg>
  );
}
