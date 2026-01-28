export function formatTimestamp(value?: string | number | Date | null): string | null {
  if (value === null || value === undefined) return null;
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    date = new Date(value);
  } else if (typeof value === 'string') {
    date = new Date(value);
  } else if (typeof value === 'object') {
    const candidate = value as { seconds?: number; toDate?: () => Date };
    if (typeof candidate.toDate === 'function') {
      date = candidate.toDate();
    } else if (typeof candidate.seconds === 'number') {
      date = new Date(candidate.seconds * 1000);
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (Number.isNaN(date.getTime())) return null;

  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = String(date.getDate()).padStart(2, '0');
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 || 12;
  const hourText = String(hour12).padStart(2, '0');

  return `${month} ${day} ${hourText}:${minutes} ${period}`;
}
