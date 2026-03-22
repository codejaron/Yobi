export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function linearRegressionSlope(points: Array<[number, number]>): number {
  const count = points.length;
  if (count < 2) {
    return 0;
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const denominator = count * sumXX - sumX * sumX;
  if (denominator === 0) {
    return 0;
  }

  return (count * sumXY - sumX * sumY) / denominator;
}
