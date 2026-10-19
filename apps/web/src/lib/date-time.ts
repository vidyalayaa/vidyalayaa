export function toDateTimeLocal(value: unknown, timeZone = 'Asia/Kolkata') {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(String(value)));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// A datetime-local input is a wall-clock time in the school's zone, regardless
// of the browser's own zone. Reject gaps/ambiguous DST times instead of shifting.
export function fromDateTimeLocal(value: string, timeZone = 'Asia/Kolkata') {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('Enter a valid date and time.');
  const wall = Date.parse(`${value}:00Z`);
  let candidate = wall;
  for (let i = 0; i < 5; i++) {
    const actual = Date.parse(
      `${toDateTimeLocal(new Date(candidate).toISOString(), timeZone)}:00Z`,
    );
    if (actual === wall) break;
    candidate += wall - actual;
  }
  if (toDateTimeLocal(new Date(candidate).toISOString(), timeZone) !== value)
    throw new Error('This local time does not exist in the school timezone. Choose another time.');
  for (const delta of [-7200000, -3600000, -1800000, 1800000, 3600000, 7200000])
    if (toDateTimeLocal(new Date(candidate + delta).toISOString(), timeZone) === value)
      throw new Error('This time occurs twice in the school timezone. Choose an unambiguous time.');
  return new Date(candidate).toISOString();
}
