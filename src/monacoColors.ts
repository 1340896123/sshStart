// CSS minifiers shorten hex values, but Monaco's token color map only accepts
// six or eight digits, including for editor.foreground/editor.background.
export function normalizeMonacoColor(value: string): string {
  const color = value.trim();
  return /^#[\da-f]{3,4}$/i.test(color)
    ? `#${[...color.slice(1)].map((digit) => digit.repeat(2)).join("")}`
    : color;
}
