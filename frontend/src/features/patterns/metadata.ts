import type { PatternKey } from "./pattern-analysis";

/**
 * Historical hit-rate ranges for the patterns: the share of setups that resolved in the forecast
 * direction, as [low, high], attributed to PATTERN_ACCURACY_SOURCE. The spread is kept visible
 * rather than collapsed into one tidy number. They say nothing about how far the target was reached
 * before a setup counted, and results move with the market, timeframe and confirmation rules, so
 * this is a reference and not a forecast.
 *
 * Every pattern key is required here, so adding a pattern means adding its figure too.
 */
export const PATTERN_ACCURACY: Record<PatternKey, [number, number]> = {
  bull_flag: [83, 85],
  bear_flag: [83, 85],
  inverse_head_and_shoulders: [74, 83],
  head_and_shoulders: [74, 81],
  ascending_triangle: [75, 83],
  descending_triangle: [75, 75],
  double_bottom: [72, 78],
  double_top: [72, 75],
  rising_wedge: [68, 81],
  falling_wedge: [68, 74],
  symmetrical_triangle: [65, 65],
};

/** A single published figure reads as itself; a spread keeps its range. */
export function accuracyText([low, high]: [number, number]) {
  return low === high ? `${low}%` : `${low}% – ${high}%`;
}

/** Where the success-rate figures come from, so the card does not present unattributed numbers. */
export const PATTERN_ACCURACY_SOURCE =
  "Thomas N. Bulkowski, Encyclopedia of Chart Patterns, 3rd edition (2021)";

/** How each shape is confirmed and measured, mirroring the rules in ./pattern-analysis. */
export const PATTERN_NOTES: Record<PatternKey, string> = {
  head_and_shoulders:
    "Confirmed by a close below the neckline. Target is the neckline minus the head's height. The right shoulder is projected from the left one while it is still missing.",
  inverse_head_and_shoulders:
    "Confirmed by a close above the neckline. Target is the neckline plus the head's height.",
  double_top:
    "Confirmed by a close below the reaction low. Target is that low minus the distance from the first top.",
  double_bottom:
    "Confirmed by a close above the reaction high. Target is that high plus the distance from the first bottom.",
  bull_flag:
    "Confirmed by a close above the channel. Target is the channel top plus the pole's height. Only matched before the flag breaks out.",
  bear_flag:
    "Confirmed by a close below the channel. Target is the channel bottom minus the pole's height.",
  ascending_triangle:
    "Confirmed by a close above the flat side. Target is that side plus the widest early width. Watch for a rising floor that keeps meeting resistance.",
  descending_triangle:
    "Confirmed by a close below the flat side. Target is that side minus the widest early width.",
  symmetrical_triangle:
    "Confirmed by a close outside either side. Both measured moves are drawn, since the direction is not known in advance.",
  rising_wedge:
    "Confirmed by a close below the wedge. Target is the lower side minus the widest early width. Both sides rise, with the lower one steeper, which is the bearish reading.",
  falling_wedge:
    "Confirmed by a close above the wedge. Target is the upper side plus the widest early width.",
};
