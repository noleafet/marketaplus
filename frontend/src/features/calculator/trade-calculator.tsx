"use client";

import { useEffect, useRef, useState } from "react";
import { fmt, percentText } from "@/lib/format";
import type { TradeDirection, TradeEntryDrawing } from "@/types/market";

type Direction = "auto" | TradeDirection;

type Props = {
  symbol: string;
  timeframe: string;
  /** Live last price, used as the entry until the user pauses or types a different one. */
  price: number | null;
  ema100: number | null;
  rsi14: number | null;
  atr14: number | null;
  /** True while this symbol already has calculator stop/target boxes on the chart. */
  hasEntryDrawing: boolean;
  onDrawEntry: (drawing: TradeEntryDrawing) => void;
  onClearEntry: () => void;
};

const inputPrice = (value: number) => String(Number(value.toPrecision(10)));

export default function TradeCalculator({
  symbol,
  timeframe,
  price,
  ema100,
  rsi14,
  atr14,
  hasEntryDrawing,
  onDrawEntry,
  onClearEntry,
}: Props) {
  const [entry, setEntry] = useState("");
  const [direction, setDirection] = useState<Direction>("auto");
  const [atrMultiple, setAtrMultiple] = useState("1.5");
  const [riskReward, setRiskReward] = useState("2");
  const [followingLatest, setFollowingLatest] = useState(true);
  const market = `${symbol}:${timeframe}`;
  const marketRef = useRef(market);

  // A new pair or interval starts again from that market's latest price.
  useEffect(() => {
    if (marketRef.current === market) return;
    marketRef.current = market;
    setFollowingLatest(true);
  }, [market]);

  // Follow the live price until the entry is paused or edited.
  useEffect(() => {
    if (!followingLatest) return;
    setEntry(price === null ? "" : inputPrice(price));
  }, [price, followingLatest]);

  const entryValue = Number(entry);
  const multiple = Number(atrMultiple);
  const rewardRatio = Number(riskReward);
  const hasEntry = Number.isFinite(entryValue) && entryValue > 0;
  const hasAtr =
    atr14 !== null &&
    Number.isFinite(atr14) &&
    atr14 > 0 &&
    Number.isFinite(multiple) &&
    multiple > 0;
  const hasRewardRatio = Number.isFinite(rewardRatio) && rewardRatio > 0;
  const trend =
    hasEntry && ema100 !== null ? (entryValue >= ema100 ? "long" : "short") : null;
  const resolvedDirection = direction === "auto" ? trend : direction;
  const directionKnown =
    resolvedDirection === "long" || resolvedDirection === "short";
  const isLong = resolvedDirection === "long";
  const rawStop =
    hasEntry && hasAtr && directionKnown
      ? isLong
        ? entryValue - atr14! * multiple
        : entryValue + atr14! * multiple
      : null;
  const stop = rawStop !== null && rawStop > 0 ? rawStop : null;
  const risk = stop === null ? null : Math.abs(entryValue - stop);
  const target =
    risk === null || !hasRewardRatio
      ? null
      : isLong
        ? entryValue + risk * rewardRatio
        : entryValue - risk * rewardRatio;
  const stopPercent = stop === null ? null : ((stop - entryValue) / entryValue) * 100;
  const targetPercent =
    target === null ? null : ((target - entryValue) / entryValue) * 100;
  const emaConfirms =
    directionKnown && ema100 !== null
      ? isLong
        ? entryValue >= ema100
        : entryValue <= ema100
      : null;
  const rsiConfirms =
    directionKnown && rsi14 !== null
      ? isLong
        ? rsi14 >= 50
        : rsi14 <= 50
      : null;
  const rsiState =
    rsi14 === null
      ? "unavailable"
      : rsi14 >= 70
        ? "overbought"
        : rsi14 <= 30
          ? "oversold"
          : "neutral";
  // RSI is bullish above the midline and bearish below it, matching the pane legend.
  const rsiTone =
    rsi14 === null || !Number.isFinite(rsi14) || rsi14 === 50
      ? undefined
      : rsi14 > 50
        ? "tone-bullish"
        : "tone-bearish";

  const note = !hasEntry
    ? "Enter the price you plan to buy or sell at."
    : !hasAtr
      ? "ATR 14 is not available for this market yet."
      : !directionKnown
        ? "EMA 100 is not available yet; choose Long or Short."
        : stop === null
          ? "The ATR stop is below zero; lower the ATR multiple."
          : target === null || target <= 0
            ? "The take profit is at or below zero; lower the risk / reward."
            : emaConfirms === false
            ? `EMA 100 does not confirm the ${resolvedDirection} direction — lower confidence.`
            : rsiConfirms === false
              ? `RSI ${rsi14!.toFixed(1)} does not confirm the ${resolvedDirection} direction — lower confidence.`
              : rsi14 === null
                ? "RSI 14 is not available yet; only EMA 100 and ATR are used."
                : (isLong && rsi14 >= 70) || (!isLong && rsi14 <= 30)
                  ? `EMA 100 and RSI agree, but RSI is ${rsiState}; the move may be stretched.`
                  : `EMA 100 and RSI ${rsi14.toFixed(1)} agree on the ${resolvedDirection} bias.`;
  // Both boxes need real prices: the red risk box ends at the stop, the green box at the target.
  const canDraw =
    hasEntry &&
    directionKnown &&
    stop !== null &&
    target !== null &&
    target > 0 &&
    stop !== entryValue &&
    target !== entryValue;

  function useLatestPrice() {
    setFollowingLatest(true);
    if (price !== null) setEntry(inputPrice(price));
  }

  function toggleFollowing() {
    if (followingLatest) {
      setFollowingLatest(false);
    } else {
      useLatestPrice();
    }
  }

  function drawEntry() {
    if (!canDraw || stop === null || target === null) return;
    if (resolvedDirection !== "long" && resolvedDirection !== "short") return;
    onDrawEntry({
      symbol,
      direction: resolvedDirection,
      entry: entryValue,
      stop,
      target,
    });
  }

  return (
    <div className="calculator">
      <div className="calculator-live">
        <span className={`calculator-live-status ${followingLatest ? "live" : "paused"}`}>
          <i aria-hidden="true" />
          {followingLatest ? "Following latest" : "Entry paused"} · {fmt(price)}
        </span>
        <div className="calculator-live-actions">
          <button
            type="button"
            className={followingLatest ? "" : "active"}
            aria-pressed={!followingLatest}
            title={
              followingLatest
                ? "Stop copying the latest price into the entry"
                : "Resume copying the latest price into the entry"
            }
            onClick={toggleFollowing}
          >
            {followingLatest ? "Pause live" : "Resume live"}
          </button>
          <button
            type="button"
            disabled={followingLatest || price === null}
            onClick={useLatestPrice}
          >
            Use latest
          </button>
        </div>
      </div>

      <div className="calculator-row">
        <label className="calculator-field">
          Entry price
          <input
            type="number"
            min="0"
            step="any"
            value={entry}
            onChange={(event) => {
              setFollowingLatest(false);
              setEntry(event.target.value);
            }}
          />
        </label>
        <label className="calculator-field">
          Direction
          <select
            value={direction}
            onChange={(event) => setDirection(event.target.value as Direction)}
          >
            <option value="auto">Auto · EMA 100</option>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
      </div>

      <div className="calculator-row">
        <label className="calculator-field">
          ATR ×
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={atrMultiple}
            onChange={(event) => setAtrMultiple(event.target.value)}
          />
        </label>
        <label className="calculator-field">
          Risk / reward
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={riskReward}
            onChange={(event) => setRiskReward(event.target.value)}
          />
        </label>
      </div>

      <div className="calculator-context">
        <div>
          <span>EMA 100</span>
          <b>{fmt(ema100)}</b>
        </div>
        <div>
          <span>RSI 14</span>
          <b className={rsiTone}>{rsi14 === null ? "–" : rsi14.toFixed(1)}</b>
        </div>
        <div>
          <span>ATR 14</span>
          <b>{fmt(atr14)}</b>
        </div>
      </div>

      <div className="calculator-bias-row">
        <span className={`calculator-bias ${resolvedDirection ?? "neutral"}`}>
          {direction === "auto" ? "AUTO " : ""}
          {resolvedDirection ? resolvedDirection.toUpperCase() : "NO BIAS"}
        </span>
        <span className="calculator-symbol">
          {symbol} · {timeframe.toUpperCase()}
        </span>
      </div>

      <div className="calculator-results">
        <div className="calculator-result stop">
          <span>Stop loss</span>
          <strong>{fmt(stop)}</strong>
          <small>{percentText(stopPercent)}</small>
        </div>
        <div className="calculator-result target">
          <span>Take profit</span>
          <strong>{fmt(target)}</strong>
          <small>{percentText(targetPercent)}</small>
        </div>
        <div className="calculator-result">
          <span>Risk distance</span>
          <strong>{fmt(risk)}</strong>
          <small>ATR × {hasAtr ? multiple : "–"}</small>
        </div>
        <div className="calculator-result">
          <span>Reward distance</span>
          <strong>
            {fmt(risk !== null && hasRewardRatio ? risk * rewardRatio : null)}
          </strong>
          <small>{hasRewardRatio ? `${rewardRatio.toFixed(2)}R` : "–"}</small>
        </div>
      </div>

      {hasEntryDrawing ? (
        <button
          type="button"
          className="calculator-draw undraw"
          title="Remove the stop-loss and take-profit boxes from the chart"
          onClick={onClearEntry}
        >
          Undraw stop &amp; target boxes
        </button>
      ) : (
        <button
          type="button"
          className={`calculator-draw ${resolvedDirection ?? ""}`}
          disabled={!canDraw}
          title={
            canDraw
              ? "Draw red stop-loss and green take-profit boxes on the price chart"
              : !hasEntry
                ? "Enter a valid entry price first"
                : !directionKnown
                  ? "Choose Long or Short first"
                  : "Set valid ATR and risk / reward values first"
          }
          onClick={drawEntry}
        >
          {resolvedDirection === "long"
            ? "Draw long stop & target boxes"
            : resolvedDirection === "short"
              ? "Draw short stop & target boxes"
              : "Draw stop & target boxes"}
        </button>
      )}

      <p className="calculator-note">{note}</p>
    </div>
  );
}
