import type { RefObject } from "react";
import TradeCalculator from "@/features/calculator/trade-calculator";
import CandlestickPictures from "@/features/candlesticks/components/candlestick-pictures";
import PatternPictures from "@/features/patterns/components/pattern-pictures";
import type {
  AnnotateTab, Drawing, LineAlert, PatternShot, Timeframe, TradeEntryDrawing,
} from "@/types/market";
import DrawingsList from "./drawings-list";

type CalculatorValues = {
  price: number | null;
  ema100: number | null;
  rsi14: number | null;
  atr14: number | null;
};

type Props = {
  symbol: string;
  timeframe: Timeframe;
  tab: AnnotateTab;
  onTabChange: (tab: AnnotateTab) => void;
  drawings: Drawing[];
  alerts: LineAlert[];
  selected: string | null;
  onSelectDrawing: (id: string) => void;
  onUpdateDrawing: (id: string, update: Partial<Drawing>) => void;
  onRemoveDrawing: (id: string) => void;
  onCreateLineAlert: (drawing: Drawing, condition: string, frequency: string) => Promise<void>;
  onDeleteLineAlert: (drawing: Drawing) => void;
  patternGroups: Map<string, PatternShot[]>;
  patternOrder: string[];
  patternNotice: string;
  onDeletePattern: (id: number) => void;
  onClearPatterns: (symbol: string) => void;
  clearingPatterns: string | null;
  armedPatterns: string | null;
  patternArmRef: RefObject<HTMLButtonElement | null>;
  candlestickGroups: Map<string, PatternShot[]>;
  candlestickOrder: string[];
  candlestickNotice: string;
  onDeleteCandlestick: (id: number) => void;
  onClearCandlesticks: (symbol: string) => void;
  clearingCandlesticks: string | null;
  armedCandlesticks: string | null;
  candlestickArmRef: RefObject<HTMLButtonElement | null>;
  calculator: CalculatorValues;
  hasEntryDrawing: boolean;
  onDrawEntry: (drawing: TradeEntryDrawing) => void;
  onClearEntry: () => void;
};

const titleFor = (tab: AnnotateTab) =>
  tab === "drawings"
    ? "Drawings"
    : tab === "pattern"
      ? "Patterns"
      : tab === "candlestick"
        ? "Candlesticks"
        : "Calculator";

export default function AnnotatePanel({
  symbol,
  timeframe,
  tab,
  onTabChange,
  drawings,
  alerts,
  selected,
  onSelectDrawing,
  onUpdateDrawing,
  onRemoveDrawing,
  onCreateLineAlert,
  onDeleteLineAlert,
  patternGroups,
  patternOrder,
  patternNotice,
  onDeletePattern,
  onClearPatterns,
  clearingPatterns,
  armedPatterns,
  patternArmRef,
  candlestickGroups,
  candlestickOrder,
  candlestickNotice,
  onDeleteCandlestick,
  onClearCandlesticks,
  clearingCandlesticks,
  armedCandlesticks,
  candlestickArmRef,
  calculator,
  hasEntryDrawing,
  onDrawEntry,
  onClearEntry,
}: Props) {
  const count =
    tab === "drawings"
      ? `${drawings.length} ON ${symbol}`
      : tab === "pattern"
        ? `${[...patternGroups.values()].reduce((sum, shots) => sum + shots.length, 0)} SAVED`
        : tab === "candlestick"
          ? `${[...candlestickGroups.values()].reduce((sum, shots) => sum + shots.length, 0)} SAVED`
          : `${symbol} · ${timeframe.toUpperCase()}`;

  return (
    <section className="panel workspace-panel" id="annotate">
      <div className="panel-head">
        <div>
          <p className="eyebrow">ANNOTATE</p>
          <h2>{titleFor(tab)}</h2>
        </div>
        <span className="count">{count}</span>
      </div>
      <div className="annotate-tabs" role="tablist" aria-label="Annotation views">
        <button
          type="button"
          role="tab"
          id="annotate-tab-drawings"
          aria-selected={tab === "drawings"}
          aria-controls="annotate-panel"
          className={tab === "drawings" ? "active" : ""}
          onClick={() => onTabChange("drawings")}
        >
          Drawings
        </button>
        <button
          type="button"
          role="tab"
          id="annotate-tab-pattern"
          aria-selected={tab === "pattern"}
          aria-controls="annotate-panel"
          className={tab === "pattern" ? "active" : ""}
          onClick={() => onTabChange("pattern")}
        >
          Patterns
        </button>
        <button
          type="button"
          role="tab"
          id="annotate-tab-candlestick"
          aria-selected={tab === "candlestick"}
          aria-controls="annotate-panel"
          className={tab === "candlestick" ? "active" : ""}
          onClick={() => onTabChange("candlestick")}
        >
          Candlesticks
        </button>
        <button
          type="button"
          role="tab"
          id="annotate-tab-calculator"
          aria-selected={tab === "calculator"}
          aria-controls="annotate-panel"
          className={tab === "calculator" ? "active" : ""}
          onClick={() => onTabChange("calculator")}
        >
          Calculator
        </button>
      </div>
      <div id="annotate-panel" role="tabpanel" aria-labelledby={`annotate-tab-${tab}`}>
        {tab === "drawings" ? (
          <DrawingsList
            drawings={drawings}
            alerts={alerts}
            selected={selected}
            onSelect={onSelectDrawing}
            onUpdate={onUpdateDrawing}
            onRemove={onRemoveDrawing}
            onCreateAlert={onCreateLineAlert}
            onDeleteAlert={onDeleteLineAlert}
          />
        ) : tab === "pattern" ? (
          <PatternPictures
            groups={patternGroups}
            order={patternOrder}
            notice={patternNotice}
            current={symbol}
            onDelete={onDeletePattern}
            onClear={onClearPatterns}
            clearing={clearingPatterns}
            armed={armedPatterns}
            armRef={patternArmRef}
          />
        ) : tab === "candlestick" ? (
          <CandlestickPictures
            groups={candlestickGroups}
            order={candlestickOrder}
            notice={candlestickNotice}
            current={symbol}
            onDelete={onDeleteCandlestick}
            onClear={onClearCandlesticks}
            clearing={clearingCandlesticks}
            armed={armedCandlesticks}
            armRef={candlestickArmRef}
          />
        ) : (
          <TradeCalculator
            symbol={symbol}
            timeframe={timeframe}
            price={calculator.price}
            ema100={calculator.ema100}
            rsi14={calculator.rsi14}
            atr14={calculator.atr14}
            hasEntryDrawing={hasEntryDrawing}
            onDrawEntry={onDrawEntry}
            onClearEntry={onClearEntry}
          />
        )}
      </div>
    </section>
  );
}
