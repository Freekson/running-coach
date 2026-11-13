/** Filled annular sectors avoid dashed-circle artifacts for very small zone durations. */
export function zoneSectorPath(start: number, end: number, expanded: boolean): string {
  const outer = expanded ? 98 : 94
  const inner = expanded ? 66 : 70
  const point = (fraction: number, radius: number) => {
    const angle = fraction * Math.PI * 2 - Math.PI / 2
    return `${110 + Math.cos(angle) * radius} ${110 + Math.sin(angle) * radius}`
  }
  if (end - start >= 1) {
    return `M ${point(start, outer)} A ${outer} ${outer} 0 1 1 ${point(start + 0.5, outer)} A ${outer} ${outer} 0 1 1 ${point(start, outer)} L ${point(start, inner)} A ${inner} ${inner} 0 1 0 ${point(start + 0.5, inner)} A ${inner} ${inner} 0 1 0 ${point(start, inner)} Z`
  }
  const large = end - start > 0.5 ? 1 : 0
  return `M ${point(start, outer)} A ${outer} ${outer} 0 ${large} 1 ${point(end, outer)} L ${point(end, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(start, inner)} Z`
}
