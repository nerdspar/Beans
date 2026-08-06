/**
 * Writing CSV.
 *
 * Small and deliberate rather than a dependency. The rules that matter are few — quote a field
 * containing a comma, a quote or a newline, and double any quote inside it — and getting them
 * wrong is the difference between a file that opens and one that silently shifts every column.
 *
 * **Money is written as a decimal string, never a number.** Same rule as the API boundary: a
 * spreadsheet will happily read `1e+21` back as a float, and this file exists so somebody can leave
 * with their data intact.
 */

/** Quotes only where the format requires it, so the file stays readable in a text editor. */
function field(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [headers.map(field).join(',')]
  for (const row of rows) lines.push(row.map(field).join(','))

  /*
   * CRLF, and a trailing newline.
   *
   * RFC 4180 specifies CRLF, and Excel on Windows is the reader most likely to be strict about it.
   * Everything else accepts it. The trailing newline keeps `wc -l` and a `cat` of two files honest.
   */
  return `${lines.join('\r\n')}\r\n`
}

/**
 * A filename with the household's own date in it.
 *
 * Dated because an export is a point-in-time copy and two of them in a downloads folder are
 * otherwise indistinguishable — which matters most in exactly the situation this feature exists
 * for, moving to another app and needing to know which file is current.
 */
export function exportFilename(resource: string, today: string): string {
  return `beans-${resource}-${today}.csv`
}
