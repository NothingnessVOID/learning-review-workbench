/** Calendar filters belong to the browser's local timezone, including DST. */
function localDay(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("日期格式无效。");
  const [, year, month, day] = match.map(Number);
  const result = new Date(0);
  result.setFullYear(year, month - 1, day);
  result.setHours(0, 0, 0, 0);
  if (
    result.getFullYear() !== year ||
    result.getMonth() !== month - 1 ||
    result.getDate() !== day
  )
    throw new Error("此本地日期不存在。");
  return result;
}

/** Legacy timestamp bounds pass through; date inputs become [start, next day). */
export function calendarDateRange<T extends Record<string, unknown>>(
  args: T,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...args };
  if (typeof args.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.from))
    result.from = localDay(args.from).toISOString();
  if (typeof args.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
    const end = localDay(args.to);
    end.setDate(end.getDate() + 1);
    end.setHours(0, 0, 0, 0);
    result.to_exclusive = end.toISOString();
    delete result.to;
  }
  return result;
}
