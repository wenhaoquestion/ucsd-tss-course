import type { Series, T } from "./model";
const day = 86400000;
export function PassChart({ series, t }: { series: Series[]; t: T }) {
  const usable = series
    .filter(
      (s) =>
        s.firstPass &&
        Number.isFinite(Date.parse(s.firstPass)) &&
        s.points.some((p) => p.available !== null),
    )
    .slice(0, 4);
  if (usable.length < 2) return null;
  const lines = usable.map((s) => ({
    term: s.term,
    points: s.points
      .filter((p) => p.available !== null)
      .map((p) => ({
        d: (Date.parse(p.at) - Date.parse(s.firstPass!)) / day,
        n: p.available!,
      }))
      .filter((p) => Number.isFinite(p.d) && p.d >= -2 && p.d <= 23)
      .sort((a, b) => a.d - b.d),
  }));
  const max = Math.max(1, ...lines.flatMap((l) => l.points.map((p) => p.n)));
  const x = (d: number) => 10 + ((d + 2) / 25) * 258,
    y = (n: number) => 79 - (n / max) * 66;
  const colours = ["#c43d23", "#37644f", "#5d5390", "#41688b"];
  return (
    <figure className="pass-chart">
      <figcaption>
        {t("Open seats from First Pass", "按 First Pass 对齐的余位")}
      </figcaption>
      <svg
        viewBox="0 0 280 95"
        role="img"
        aria-label={t(
          "Historic seat counts over the same enrollment window",
          "同一选课阶段的历史余位",
        )}
      >
        <path d="M10 13H272M10 46H272M10 79H272" fill="none" stroke="#ddd" />
        <path d={"M" + x(0) + " 10V80"} stroke="#888" strokeDasharray="2 2" />
        {lines.map((l, i) => (
          <g key={l.term} fill={colours[i]}>
            {l.points.map((p, j) => {
              const prev = l.points[j - 1];
              return (
                <g key={j}>
                  {prev && p.d - prev.d < 1.5 && (
                    <line
                      x1={x(prev.d)}
                      y1={y(prev.n)}
                      x2={x(p.d)}
                      y2={y(p.n)}
                      stroke={colours[i]}
                      strokeWidth="1.5"
                    />
                  )}
                  <circle cx={x(p.d)} cy={y(p.n)} r="1.6">
                    <title>
                      {l.term + " · D" + p.d.toFixed(1) + " · " + p.n}
                    </title>
                  </circle>
                </g>
              );
            })}
          </g>
        ))}
        {[0, 7, 14, 21].map((d) => (
          <text
            key={d}
            x={x(d)}
            y="92"
            textAnchor="middle"
            fontSize="9"
            fill="#60675f"
          >
            D{d}
          </text>
        ))}
      </svg>
      <div className="legend">
        {lines.map((l, i) => (
          <span key={l.term} style={{ color: colours[i] }}>
            ● {l.term}
          </span>
        ))}
      </div>
    </figure>
  );
}
