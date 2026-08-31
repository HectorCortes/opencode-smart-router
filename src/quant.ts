import type { QuantLadder } from "./types.js";

export const QUANT_LADDER: QuantLadder = {
  int4: 0.1,
  int8: 0.3,
  fp8: 0.5,
  fp16: 0.7,
  bf16: 0.85,
  fp32: 1.0,
  unknown: 0,
};

export function rankOf(ladder: QuantLadder, quant: string): number {
  const index = Object.keys(ladder).indexOf(quant);
  return index < 0 ? -1 : index;
}

export function quantScore(ladder: QuantLadder, quant: string | undefined): number {
  if (!quant) {
    return 0;
  }
  return ladder[quant] ?? 0;
}

export function meetsQuantFloor(ladder: QuantLadder, floor: string, quant: string | undefined): boolean {
  if (quant === undefined || quant === "unknown") {
    return false;
  }
  const floorRank = rankOf(ladder, floor);
  const quantRank = rankOf(ladder, quant);
  if (floorRank < 0 || quantRank < 0) {
    return false;
  }
  return quantRank >= floorRank;
}