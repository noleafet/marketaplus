import { patternChoices, type PatternKey } from "../pattern-analysis";

/** A point in diagram space: x runs left to right, y runs from the bottom to the top (0–1). */
type Point = [number, number];

type Diagram = {
  /** The price path that draws the shape, including the move after confirmation. */
  price: Point[];
  /** Optional trendlines and reaction levels that make the shape easier to read. */
  guides: [Point, Point][];
  /** The level a close through confirms the pattern. */
  entry: [Point, Point];
  /** The measured move after the entry. */
  target: [Point, Point];
};

const headAndShoulders: Diagram = {
  price: [
    [0.02, 0.4], [0.1, 0.54], [0.18, 0.68],
    [0.26, 0.54], [0.32, 0.44],
    [0.4, 0.64], [0.48, 0.86],
    [0.56, 0.62], [0.63, 0.44],
    [0.7, 0.56], [0.78, 0.66],
    [0.86, 0.42], [0.94, 0.26], [1, 0.16],
  ],
  guides: [],
  entry: [[0.32, 0.44], [1, 0.46]],
  target: [[0.78, 0.05], [1, 0.05]],
};

const doubleTop: Diagram = {
  price: [
    [0.02, 0.3], [0.12, 0.5], [0.22, 0.82],
    [0.32, 0.58], [0.42, 0.45],
    [0.52, 0.64], [0.62, 0.8],
    [0.72, 0.56], [0.82, 0.34], [0.92, 0.22], [1, 0.14],
  ],
  // The twin highs are the pattern's defining level.
  guides: [[[0.22, 0.82], [0.62, 0.82]]],
  entry: [[0.42, 0.45], [1, 0.45]],
  target: [[0.62, 0.08], [1, 0.08]],
};

const bullFlag: Diagram = {
  price: [
    [0.02, 0.24], [0.1, 0.34], [0.2, 0.5], [0.3, 0.62],
    [0.36, 0.56], [0.44, 0.5], [0.52, 0.52], [0.6, 0.46], [0.68, 0.48],
    [0.8, 0.62], [0.9, 0.72], [1, 0.84],
  ],
  // The two channel lines hold the pause after the pole.
  guides: [
    [[0.3, 0.6], [0.78, 0.52]],
    [[0.3, 0.44], [0.78, 0.42]],
  ],
  entry: [[0.3, 0.52], [1, 0.52]],
  target: [[0.68, 0.88], [1, 0.88]],
};

const ascendingTriangle: Diagram = {
  price: [
    [0.02, 0.34], [0.12, 0.52], [0.2, 0.64],
    [0.3, 0.46], [0.4, 0.38],
    [0.5, 0.58], [0.6, 0.64],
    [0.7, 0.48], [0.78, 0.44],
    [0.86, 0.58], [0.93, 0.72], [1, 0.84],
  ],
  guides: [[[0.02, 0.34], [0.86, 0.54]]],
  entry: [[0.2, 0.64], [1, 0.64]],
  target: [[0.78, 0.92], [1, 0.92]],
};

const symmetricalTriangle: Diagram = {
  price: [
    [0.02, 0.45], [0.12, 0.64], [0.22, 0.36], [0.32, 0.6], [0.42, 0.42],
    [0.52, 0.56], [0.62, 0.46], [0.72, 0.52],
    [0.82, 0.66], [0.92, 0.76], [1, 0.84],
  ],
  guides: [
    [[0.02, 0.7], [0.82, 0.54]],
    [[0.02, 0.24], [0.82, 0.44]],
  ],
  entry: [[0.62, 0.54], [1, 0.54]],
  target: [[0.76, 0.82], [1, 0.82]],
};

const risingWedge: Diagram = {
  price: [
    [0.02, 0.28], [0.1, 0.42], [0.2, 0.38], [0.3, 0.54], [0.4, 0.5],
    [0.5, 0.64], [0.6, 0.58], [0.7, 0.72], [0.78, 0.66],
    [0.86, 0.54], [0.94, 0.38], [1, 0.26],
  ],
  guides: [
    [[0.02, 0.36], [0.82, 0.8]],
    [[0.02, 0.18], [0.82, 0.66]],
  ],
  entry: [[0.78, 0.6], [1, 0.6]],
  target: [[0.88, 0.42], [1, 0.42]],
};

/**
 * The opposite shape is the same geometry turned upside down, so the bearish and inverted
 * examples are generated rather than hand-copied. That keeps every pair of pictures symmetrical.
 */
function mirror(diagram: Diagram): Diagram {
  const flip = ([x, y]: Point): Point => [x, 1 - y];
  return {
    price: diagram.price.map((point) => flip(point)),
    guides: diagram.guides.map(([from, to]) => [flip(from), flip(to)]),
    entry: [flip(diagram.entry[0]), flip(diagram.entry[1])],
    target: [flip(diagram.target[0]), flip(diagram.target[1])],
  };
}

const SAMPLES: Record<PatternKey, Diagram> = {
  head_and_shoulders: headAndShoulders,
  inverse_head_and_shoulders: mirror(headAndShoulders),
  double_top: doubleTop,
  double_bottom: mirror(doubleTop),
  bull_flag: bullFlag,
  bear_flag: mirror(bullFlag),
  ascending_triangle: ascendingTriangle,
  descending_triangle: mirror(ascendingTriangle),
  symmetrical_triangle: symmetricalTriangle,
  rising_wedge: risingWedge,
  falling_wedge: mirror(risingWedge),
};

const WIDTH = 248;
const HEIGHT = 138;
const PLOT = { left: 10, right: 182, top: 12, bottom: 124 };
const xAt = (x: number) => PLOT.left + x * (PLOT.right - PLOT.left);
const yAt = (y: number) => PLOT.bottom - y * (PLOT.bottom - PLOT.top);
const pointText = ([x, y]: Point) => `${xAt(x)},${yAt(y)}`;

/** A small pill in the margin to the right of the chart, level with the line it names. */
function LevelLabel({ point, text, tone }: { point: Point; text: string; tone: string }) {
  const width = text.length * 5.3 + 9;
  const x = Math.min(xAt(point[0]) + 4, WIDTH - width - 2);
  const y = Math.max(2, Math.min(HEIGHT - 16, yAt(point[1]) - 7));
  return (
    <g className={`pattern-sample-label ${tone}`}>
      <rect x={x} y={y} width={width} height={14} rx={3} />
      <text x={x + 4.5} y={y + 9.8}>{text}</text>
    </g>
  );
}

/** One hand-drawn pattern sample with its confirmation entry and measured target. */
export default function PatternSample({ pattern }: { pattern: PatternKey }) {
  const diagram = SAMPLES[pattern];
  const choice = patternChoices.find((item) => item.value === pattern);
  const bias = choice?.bias ?? "bullish";
  const entry = diagram.entry;
  const target = diagram.target;
  return (
    <svg
      className="pattern-sample"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${choice?.label ?? pattern} sample showing the entry and target`}
    >
      <line
        className="pattern-sample-base"
        x1={PLOT.left}
        y1={PLOT.bottom}
        x2={PLOT.right}
        y2={PLOT.bottom}
      />
      {diagram.guides.map(([from, to], index) => (
        <line
          className="pattern-sample-guide"
          key={index}
          x1={xAt(from[0])}
          y1={yAt(from[1])}
          x2={xAt(to[0])}
          y2={yAt(to[1])}
        />
      ))}
      <polyline className="pattern-sample-price" points={diagram.price.map(pointText).join(" ")} />
      <line
        className="pattern-sample-entry"
        x1={xAt(entry[0][0])}
        y1={yAt(entry[0][1])}
        x2={xAt(entry[1][0])}
        y2={yAt(entry[1][1])}
      />
      <line
        className={`pattern-sample-target ${bias}`}
        x1={xAt(target[0][0])}
        y1={yAt(target[0][1])}
        x2={xAt(target[1][0])}
        y2={yAt(target[1][1])}
      />
      <LevelLabel point={entry[1]} text="Entry" tone="entry" />
      <LevelLabel point={target[1]} text="Target" tone={`target ${bias}`} />
    </svg>
  );
}
