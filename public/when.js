const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(value) {
  return String(value).padStart(2, "0");
}

export function wallParts(value) {
  const text = String(value ?? "");
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]) - 1,
    day: Number(match[3]),
    hours: Number(match[4] || 0),
    minutes: Number(match[5] || 0),
  };
}

export function wallStamp(value) {
  const parts = wallParts(value);
  if (!parts) return "";
  return `${parts.year}-${pad(parts.month + 1)}-${pad(parts.day)}T${pad(parts.hours)}:${pad(parts.minutes)}`;
}

export function nowStamp() {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function gigDateLabel(value) {
  const parts = wallParts(value);
  if (!parts) return "";
  const today = new Date();
  const yearAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  const point = new Date(parts.year, parts.month, parts.day);
  if (point < yearAgo) return `${months[parts.month]} ${parts.year}`;
  return `${parts.day} ${months[parts.month]}`;
}

export function gigDay(value) {
  const parts = wallParts(value);
  if (!parts) return "";
  return `${parts.day} ${months[parts.month]} ${parts.year}`;
}

export function gigWhen(value) {
  const parts = wallParts(value);
  if (!parts) return "";
  return `${parts.day} ${months[parts.month]} ${parts.year}, ${pad(parts.hours)}:${pad(parts.minutes)}`;
}

export function isWallClock(value) {
  const text = String(value ?? "");
  return Boolean(wallParts(text)) && !/[zZ]|[+-]\d{2}:\d{2}$/.test(text);
}

export function wallHasPassed(value) {
  if (!value) return false;
  if (!isWallClock(value)) return new Date(value).getTime() < Date.now();
  const stamp = wallStamp(value);
  return Boolean(stamp) && stamp < nowStamp();
}
