import { clamp01, smoothstep } from "../core/MathUtil";

// One timeline drives the hand, metal parts, audio and scope interruption.
export const BOLT_CYCLE = { eject: 0.52, close: 0.81, aim: 0.92 } as const;
const ramp = (t: number, from: number, to: number) => smoothstep(clamp01((t - from) / (to - from)));

export function sampleBoltCycle(t: number) {
  return {
    grip: ramp(t, 0.10, 0.30) * (1 - ramp(t, 0.81, 0.92)),
    lift: ramp(t, 0.30, 0.40) * (1 - ramp(t, 0.73, 0.81)),
    pull: ramp(t, 0.40, 0.54) * (1 - ramp(t, 0.61, 0.73)),
    pose: ramp(t, 0.02, 0.28) * (1 - ramp(t, 0.81, 0.94)),
  };
}
