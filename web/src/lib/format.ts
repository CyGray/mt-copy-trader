export function formatTimestamp(value?: string | number | Date | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date);
  const day = String(date.getDate()).padStart(2, '0');
  let hours = date.getHours();
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const hourStr = String(hours).padStart(2, '0');
  const minuteStr = String(date.getMinutes()).padStart(2, '0');

  return `${month} ${day} ${hourStr}:${minuteStr} ${ampm}`;
}

export function isNonEmptyMessage(value?: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}
