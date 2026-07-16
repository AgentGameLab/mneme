export function normalizedFtsScore(rank, maxMagnitude) {
  const magnitude = Math.abs(Number(rank) || 0)
  const denominator = Number(maxMagnitude) || 0
  if (magnitude === 0 || denominator <= 0) return 0
  return Math.min(1, magnitude / denominator)
}
