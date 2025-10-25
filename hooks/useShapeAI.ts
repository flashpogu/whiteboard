// hooks/useShapeAI.ts
import { useEffect, useState } from "react";

export type HeuristicPrediction = { label: string; score: number };

/**
 * 100% heuristic shape scorer (no ML libs).
 * Shapes: circle, rectangle, triangle, star, heart, cloud
 */
export function useShapeAI() {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);

  function predict(features: number[], topK: number = 6): HeuristicPrediction[] {
    const [corners, circ, ar, sym, lengthNorm] = features;

    const s: Record<string, number> = {
      circle: 0, rectangle: 0, triangle: 0, star: 0, heart: 0, cloud: 0,
    };

    s.circle = clamp01(circ * (1 - corners / 8));
    s.rectangle = closeness(corners, 4, 4) * closeness(ar, 1, 0.6);
    s.triangle = closeness(corners, 3, 3.5);
    s.star = clamp01(Math.max(0, corners - 6) / 6 * (1 - circ * 0.5));
    s.heart = clamp01(sym * (1 - Math.abs(ar - 1)) * (corners >= 2 && corners <= 6 ? 1 : 0.3));
    s.cloud = clamp01(circ * Math.min(corners / 10, 1));

    return Object.keys(s)
      .map((k) => ({ label: k, score: s[k] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  return { ready, predict };
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function closeness(v: number, target: number, scale: number) {
  return clamp01(Math.exp(-Math.pow((v - target) / (scale || 1), 2)));
}
