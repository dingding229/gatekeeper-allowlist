export function parsePortRanges(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  if (!raw.trim()) return [];

  const ranges = raw
    .split(/[\s,，]+/)
    .filter(Boolean)
    .map((token) => {
      const match = token.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
      if (!match) throw new Error(`Invalid port range: ${token}`);
      const start = Number(match[1]);
      const end = Number(match[2] || match[1]);
      if (start < 1 || end > 65535 || start > end) {
        throw new Error(`Invalid port range: ${token}`);
      }
      return { start, end };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.map(({ start, end }) =>
    start === end ? String(start) : `${start}-${end}`,
  );
}
