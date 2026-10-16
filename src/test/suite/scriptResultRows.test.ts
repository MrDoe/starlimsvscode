/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import { normalizeColumnKey, normalizeScriptResultRows } from '../../utilities/scriptResultRows';

const MEASURE_COLUMNS = ["ORIGREC", "TITLE", "DESCRIPTION", "STATUS", "PRIORITY", "TICKET_ID", "DATE_FINISHED"];

// Captured live from SCM_API TicketManagement.GetTicketMeasures(2209), Production,
// 2026-10-16: SQLExecute results come back WITHOUT a column-name header row.
const MEASURE_RESULT_WITHOUT_HEADER = [
  [495, "Analyse und Root-Cause ermittelt", "Zweite Primaerprobe wurde ohne Metadaten-GUID registriert.", "Completed", 0, 2209, "2026-10-16T09:26:36.360+02:00"],
  [494, "Datenkorrektur Registrierungszeitpunkt PS0042 vorbereitet", "UPDATE METADATA SET REGISTRATION_DATE = …", "Completed", 0, 2209, "2026-10-16T09:26:30.187+02:00"],
  [493, "Server-Protokollierung fuer fehlende Metadaten-GUID", "scAddInventoryToReception protokolliert jetzt …", "Completed", 0, 2209, "2026-10-16T09:26:30.043+02:00"],
  [492, "Code-Fix frmScanReception (Probenempfang)", "Vor jeder Probenzugabe wird jetzt gewartet …", "Completed", 0, 2209, "2026-10-16T09:26:29.870+02:00"]
];

describe('scriptResultRows normalizeScriptResultRows', () => {
  it('maps SQLExecute rows positionally when the result has no header row', () => {
    const rows = normalizeScriptResultRows(MEASURE_RESULT_WITHOUT_HEADER, MEASURE_COLUMNS);

    assert.strictEqual(rows.length, 4, 'no row may be consumed as a header row');
    assert.deepStrictEqual(rows.map((row) => row.ORIGREC), [495, 494, 493, 492]);
    assert.strictEqual(rows[0].TITLE, "Analyse und Root-Cause ermittelt");
    assert.strictEqual(rows[0].STATUS, "Completed");
    assert.strictEqual(rows[0].PRIORITY, 0);
    assert.strictEqual(rows[0].TICKET_ID, 2209);
    assert.strictEqual(rows[0].DATE_FINISHED, "2026-10-16T09:26:36.360+02:00");
  });

  it('keeps the newest measure when it is the first row of the result', () => {
    const rows = normalizeScriptResultRows(MEASURE_RESULT_WITHOUT_HEADER, MEASURE_COLUMNS);
    assert.strictEqual(rows[0].DESCRIPTION, "Zweite Primaerprobe wurde ohne Metadaten-GUID registriert.");
  });

  it('maps a single header-less row instead of consuming it as a header', () => {
    // The shape ticket history has when exactly one field was changed (scGetTicketTnx).
    const rows = normalizeScriptResultRows(
      [["", "Fehlerhafte Metadatenuebertragung bei Pooling-Proben", "TITLE", "2026-10-14T13:45:06.513+02:00", "CTISON"]],
      ["OLD_VALUE", "NEW_VALUE", "CHANGED_FIELD", "CHANGED_ON", "MODIFIED_BY"]
    );

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].CHANGED_FIELD, "TITLE");
    assert.strictEqual(rows[0].NEW_VALUE, "Fehlerhafte Metadatenuebertragung bei Pooling-Proben");
    assert.strictEqual(rows[0].MODIFIED_BY, "CTISON");
  });

  it('maps [code, name] dictionary pairs positionally', () => {
    const rows = normalizeScriptResultRows([[1, "Offen"], [2, "Fertig"], [3, "In Bearbeitung"]], ["ORIGREC", "NAME"]);
    assert.deepStrictEqual(rows.map((row) => `${row.ORIGREC}:${row.NAME}`), ["1:Offen", "2:Fertig", "3:In Bearbeitung"]);
  });

  it('uses a header row when the script really returns one', () => {
    const rows = normalizeScriptResultRows([
      ["ORIGREC", "TITLE", "DESCRIPTION", "STATUS", "PRIORITY", "TICKET_ID", "DATE_FINISHED"],
      [501, "Massnahme", "Beschreibung", "Completed", 0, 12, "2026-01-02T10:00:00.000+01:00"]
    ], MEASURE_COLUMNS);

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ORIGREC, 501);
    assert.strictEqual(rows[0].TITLE, "Massnahme");
  });

  it('does not mistake numeric data rows for a header row', () => {
    const rows = normalizeScriptResultRows([[1, "Status"], [2, "Titel"]], ["ORIGREC", "TITLE"]);
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map((row) => row.ORIGREC), [1, 2]);
  });

  it('recognises a header row through case and umlaut differences', () => {
    const rows = normalizeScriptResultRows([
      ["origrec", "TÄTIGKEIT"],
      [7, "Prüfung abgeschlossen"]
    ], ["ORIGREC", "Tatigkeit"]);

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].origrec, 7);
  });

  it('passes through arrays of named records', () => {
    const rows = normalizeScriptResultRows([
      { ORIGREC: 9, TITLE: "Massnahme A" },
      { ORIGREC: 10, TITLE: "Massnahme B" }
    ], MEASURE_COLUMNS);

    assert.deepStrictEqual(rows.map((row) => row.ORIGREC), [9, 10]);
    assert.strictEqual(rows[1].TITLE, "Massnahme B");
  });

  it('returns no rows for empty or non-array results', () => {
    assert.deepStrictEqual(normalizeScriptResultRows([], MEASURE_COLUMNS), []);
    assert.deepStrictEqual(normalizeScriptResultRows(undefined, MEASURE_COLUMNS), []);
    assert.deepStrictEqual(normalizeScriptResultRows(null, MEASURE_COLUMNS), []);
    assert.deepStrictEqual(normalizeScriptResultRows("no rows", MEASURE_COLUMNS), []);
    assert.deepStrictEqual(normalizeScriptResultRows({ data: [] }, MEASURE_COLUMNS), []);
  });

  it('clips extra or missing cells against the expected columns', () => {
    const rows = normalizeScriptResultRows([[11, "Massnahme", "extra"], [12]], ["ORIGREC", "TITLE"]);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].TITLE, "Massnahme");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rows[0], "2"), false);
    assert.strictEqual(rows[1].ORIGREC, 12);
    assert.strictEqual(rows[1].TITLE, undefined);
  });
});

describe('scriptResultRows normalizeColumnKey', () => {
  it('folds case, separators and umlauts', () => {
    assert.strictEqual(normalizeColumnKey("DATE_FINISHED"), "datefinished");
    assert.strictEqual(normalizeColumnKey("date finished"), "datefinished");
    assert.strictEqual(normalizeColumnKey("AUSGEWÄHLT"), normalizeColumnKey("Ausgewahlt"));
    assert.strictEqual(normalizeColumnKey("TÄTIGKEIT"), normalizeColumnKey("Tatigkeit"));
  });
});
