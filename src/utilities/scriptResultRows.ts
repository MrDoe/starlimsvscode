/**
 * Row normalization for SCM_API script results requested with outputType ARRAY.
 *
 * A remote procedure that returns SQLExecute output arrives as a plain array of
 * arrays WITHOUT a column-name header row (verified live 2026-10-16 against
 * TicketManagement.GetTicketMeasures: `[[495, "Analyse …", "Completed", 0, 2209,
 * "2026-10-16T09:26:36.360+02:00"], …]`), while scripts that build UDObjects
 * themselves return an array of named records. Treating the first row as a
 * header unconditionally therefore silently drops every row of a SQLExecute
 * result, so the caller states the columns it selected and a first row only
 * counts as a header when it repeats one of those names.
 */

/** One result row keyed by column name. */
export type ScriptResultRow = Record<string, unknown>;

/** Normalizes a column name so case, underscores and umlauts compare equal. */
export function normalizeColumnKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLocaleLowerCase();
}

/**
 * Maps ARRAY script output to records keyed by column name.
 *
 * @param data raw `data` of the script response
 * @param expectedColumns columns of the SELECT, in order; used positionally when
 * the result carries no header row, and to recognise a header row when it does
 */
export function normalizeScriptResultRows(data: unknown, expectedColumns: string[]): ScriptResultRow[] {
  if (!Array.isArray(data) || data.length === 0) {
    return [];
  }

  const valueRows = data.filter((row): row is unknown[] => Array.isArray(row));
  if (valueRows.length === 0) {
    // Array of named records (UDObject rows): take them as they are.
    return data
      .filter((row): row is ScriptResultRow => !!row && typeof row === "object")
      .map((row) => ({ ...row }));
  }

  const headerRow = valueRows[0];
  const isHeaderRow = expectedColumns.length > 0
    && headerRow.length > 0
    && headerRow.every((value) => typeof value === "string")
    && headerRow.some((value) => expectedColumns.some((column) => normalizeColumnKey(String(value)) === normalizeColumnKey(column)));

  const sourceRows = isHeaderRow ? valueRows.slice(1) : valueRows;
  const columns: readonly unknown[] = isHeaderRow ? headerRow : expectedColumns;

  return sourceRows.map((row) => columns.reduce<ScriptResultRow>((record, columnName, index) => {
    record[String(columnName)] = row[index];
    return record;
  }, {}));
}
