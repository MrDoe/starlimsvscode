import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { EnterpriseItemType } from '../../providers/enterpriseTreeDataProvider';
import { EnterpriseService } from '../../services/enterpriseService';
import { StarlimsAutomationOptions, StarlimsAutomationService } from '../../services/starlimsAutomationService';
import { TicketLookupData, TicketOverview, TicketReference } from '../../services/ticketManagementTypes';

function createEnterpriseServiceMock(overrides: Partial<EnterpriseService> = {}): EnterpriseService {
  return {
    languages: [],
    addItem: async () => "added",
    addItemResult: async () => ({ ok: true, data: "added" }),
    checkInItem: async () => true,
    checkOutItemResult: async () => ({ ok: true, data: true }),
    getCurrentServerName: () => 'QA',
    getEnterpriseItemCodeResult: async () => ({
      ok: true,
      data: {
        code: 'function sample() { return true; }',
        language: 'JS'
      }
    }),
    getEnterpriseItemsResult: async () => ({ ok: true, data: [] }),
    getUriFromLocalPath: (localPath: string) => localPath.replace(/\\/g, '/').replace(/^.*\/SLVSCODE/, '').replace(/\.[^.]+$/, ''),
    getLanguagesResult: async () => ({ ok: true, data: [] }),
    getLocalCopyResult: async () => ({
      ok: true,
      data: {
        code: 'function sample() { return true; }',
        language: 'JS',
        localFilePath: path.join('C:/workspace/SLVSCODE', 'sample.ssl')
      }
    }),
    getServerWorkspacePath: (workspaceRoot: string) => path.join(workspaceRoot, 'QA'),
    globalSearchResult: async () => ({ ok: true, data: [] }),
    runScript: async () => ({ success: true, data: 'execution ok' }),
    saveEnterpriseItemCodeResult: async () => ({ ok: true, data: '' }),
    saveTableDefinitionResult: async () => ({ ok: true, data: '' }),
    searchForItemsResult: async () => ({ ok: true, data: [] }),
    undoCheckOut: async () => true,
    ...overrides
  } as unknown as EnterpriseService;
}

const SAMPLE_TICKETS: TicketOverview[] = [
  {
    assignedTo: 'DC',
    author: 'MHINZE',
    createdOn: '2026-10-01T09:00:00Z',
    id: 12,
    modifiedOn: '2026-10-15T09:00:00Z',
    priorityName: 'Hoch',
    statusGroupName: 'In Bearbeitung',
    statusName: 'In Bearbeitung',
    title: 'Falsche Füllmengen im Kollektiv',
    typeName: 'Bug'
  },
  {
    assignedTo: 'DOELLINGER',
    author: 'DC',
    createdOn: '2026-10-10T09:00:00Z',
    id: 13,
    modifiedOn: '2026-10-15T12:00:00Z',
    priorityName: 'Niedrig',
    statusGroupName: 'In Prüfung',
    statusName: 'In Prüfung',
    title: 'Dauerhafte Prüfung ausstehend',
    typeName: 'Support-Anfrage'
  },
  {
    assignedTo: '',
    author: 'RSCHLEGEL',
    createdOn: '2026-09-01T09:00:00Z',
    id: 14,
    modifiedOn: '2026-09-30T09:00:00Z',
    priorityName: 'Niedrig',
    statusGroupName: 'Fertig',
    statusName: 'Fertig',
    title: 'Alles erledigt',
    typeName: 'Bug'
  }
];

const SAMPLE_TICKET_LOOKUP: TicketLookupData = {
  priorities: [{ code: 1, name: 'Nicht definiert' }, { code: 4, name: 'Hoch' }],
  severities: [{ code: 5, name: 'Nicht definiert' }],
  statuses: [{ code: 1, name: 'Offen' }, { code: 3, name: 'In Bearbeitung' }],
  types: [{ code: 1, name: 'Bug' }, { code: 4, name: 'Support-Anfrage' }]
};

function createTicketAutomationService(
  overrides: Partial<EnterpriseService> = {},
  optionOverrides: Partial<StarlimsAutomationOptions> = {}
): StarlimsAutomationService {
  return new StarlimsAutomationService(
    createEnterpriseServiceMock(overrides),
    {
      getDefaultFormLanguage: () => undefined,
      getMaxCodeCharacters: () => 20000,
      getMaxItems: () => 100,
      getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
      refreshCheckoutTree: async () => undefined,
      ...optionOverrides
    }
  );
}

suite('StarlimsAutomationService', () => {
  test('browseTree caps item results', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            { name: 'Server Scripts', type: EnterpriseItemType.ServerScriptCategory, uri: '/ServerScripts', isFolder: true },
            { name: 'Data Sources', type: EnterpriseItemType.DataSourceCategory, uri: '/DataSources', isFolder: true }
          ]
        })
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 1,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.browseTree('', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result.items as unknown[]).length, 1);
    assert.strictEqual(result.totalItems, 2);
    assert.strictEqual(result.truncated, true);
    assert.match(String(result.note), /limited/i);
  });

  test('browseTree emits leaf hint when no items and uri is non-empty', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: []
        })
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.browseTree('/ServerScripts/nonexistent', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result.items as unknown[]).length, 0);
    assert.match(String(result.note), /get_item_code/i);
  });

  test('browseTree does not emit leaf note for root uri', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: []
        })
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.browseTree('', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result.items as unknown[]).length, 0);
    assert.strictEqual(result.note, undefined);
  });

  test('browseTree rejects URI without leading slash', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock(),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.browseTree('Applications', undefined);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /must start with '\/'/i);
  });

  test('checkoutItem requires a language for form items without defaults', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'frmPatient',
              type: EnterpriseItemType.HTMLFormCode,
              uri: '/Applications/Lab/Forms/HTML/frmPatient'
            }
          ]
        })
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.checkoutItem('/Applications/Lab/Forms/HTML/frmPatient', undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.requiresLanguage, true);
  });

  test('checkoutItem uses configured default form language', async () => {
    let capturedLanguage: string | undefined;

    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        checkOutItemResult: async (_uri, language) => {
          capturedLanguage = language;
          return { ok: true, data: true };
        },
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'frmPatient',
              type: EnterpriseItemType.HTMLFormCode,
              uri: '/Applications/Lab/Forms/HTML/frmPatient'
            }
          ]
        }),
        getLocalCopyResult: async (_uri, _workspaceRoot, language) => ({
          ok: true,
          data: {
            code: 'function sample() { return true; }',
            language: language || 'GER',
            localFilePath: path.join('C:/workspace/SLVSCODE', 'sample.js')
          }
        })
      }),
      {
        getDefaultFormLanguage: () => 'GER',
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.checkoutItem('/Applications/Lab/Forms/HTML/frmPatient', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(capturedLanguage, 'GER');
    assert.strictEqual(result.language, 'GER');
  });

  test('executeServerScript applies default character limit', async () => {
    const bigOutput = 'x'.repeat(120000);
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'scBigOutput',
              type: EnterpriseItemType.ServerScript,
              uri: '/ServerScripts/BMBH/scBigOutput'
            }
          ]
        }),
        runScript: async () => ({ success: true, data: bigOutput })
      }),
      {
        getDefaultFormLanguage: () => 'GER',
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.executeServerScript('/ServerScripts/BMBH/scBigOutput', undefined, 'ARRAY', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.maxCharacters, 50000);
    assert.strictEqual(result.totalCharacters, bigOutput.length);
    assert.strictEqual(String(result.output).length, 50000);
    assert.strictEqual(result.truncated, true);
  });

  test('executeServerScript respects explicit maxCharacters override', async () => {
    const bigOutput = 'y'.repeat(8000);
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'scBigOutput',
              type: EnterpriseItemType.ServerScript,
              uri: '/ServerScripts/BMBH/scBigOutput'
            }
          ]
        }),
        runScript: async () => ({ success: true, data: bigOutput })
      }),
      {
        getDefaultFormLanguage: () => 'GER',
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.executeServerScript('/ServerScripts/BMBH/scBigOutput', undefined, 'ARRAY', undefined, 1000);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.maxCharacters, 1000);
    assert.strictEqual(String(result.output).length, 1000);
    assert.strictEqual(result.truncated, true);
  });

  test('executeDataSource caps rows with default row limit', async () => {
    const headerRow = ['ID', 'NAME'];
    const rows = [headerRow, ...Array.from({ length: 50 }, (_, i) => [`ID${i}`, `NAME${i}`])];
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'dsInventory',
              type: EnterpriseItemType.DataSource,
              uri: '/DataSources/dsInventory'
            }
          ]
        }),
        runScript: async () => ({ success: true, data: rows })
      }),
      {
        getDefaultFormLanguage: () => 'GER',
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.executeDataSource('/DataSources/dsInventory', undefined, 'ARRAY', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.totalRows, 50);
    assert.strictEqual(result.rowLimit, 500);
    assert.strictEqual(result.truncatedRows, false);
  });

  test('executeDataSource caps rows when explicit maxRows is lower', async () => {
    const headerRow = ['ID', 'NAME'];
    const rows = [headerRow, ...Array.from({ length: 50 }, (_, i) => [`ID${i}`, `NAME${i}`])];
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'dsInventory',
              type: EnterpriseItemType.DataSource,
              uri: '/DataSources/dsInventory'
            }
          ]
        }),
        runScript: async () => ({ success: true, data: rows })
      }),
      {
        getDefaultFormLanguage: () => 'GER',
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.executeDataSource('/DataSources/dsInventory', undefined, 'ARRAY', undefined, 10);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.totalRows, 50);
    assert.strictEqual(result.rowLimit, 10);
    assert.strictEqual(result.truncatedRows, true);
    assert.match(String(result.note), /limited/i);

    const parsed = JSON.parse(String(result.output));
    assert.strictEqual(parsed.length, 11);
    assert.strictEqual(parsed[0][0], 'ID');
  });

  test('executeDataSource uses configured maxDataSourceRows option', async () => {
    const headerRow = ['ID', 'NAME'];
    const rows = [headerRow, ...Array.from({ length: 30 }, (_, i) => [`ID${i}`, `NAME${i}`])];
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'dsInventory',
              type: EnterpriseItemType.DataSource,
              uri: '/DataSources/dsInventory'
            }
          ]
        }),
        runScript: async () => ({ success: true, data: rows })
      }),
      {
        getDefaultFormLanguage: () => 'GER',
        getMaxCodeCharacters: () => 20000,
        getMaxDataSourceRows: () => 5,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.executeDataSource('/DataSources/dsInventory', undefined, 'ARRAY', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.totalRows, 30);
    assert.strictEqual(result.rowLimit, 5);
    assert.strictEqual(result.truncatedRows, true);
  });
  test('executeServerScript rejects data source items', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'dsInventory',
              type: EnterpriseItemType.DataSource,
              uri: '/DataSources/dsInventory'
            }
          ]
        })
      }),
      {
        getDefaultFormLanguage: () => 'GER',
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.executeServerScript('/DataSources/dsInventory', undefined, 'ARRAY', undefined);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /not a STARLIMS server script/i);
  });

  test('checkinItem uses configured default form language', async () => {
    let capturedLanguage: string | undefined;

    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        checkInItem: async (_uri, _reason, language) => {
          capturedLanguage = language;
          return true;
        },
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'frmPatient',
              type: EnterpriseItemType.HTMLFormCode,
              uri: '/Applications/Lab/Forms/HTML/frmPatient'
            }
          ]
        })
      }),
      {
        getDefaultFormLanguage: () => 'GER',
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.checkinItem('/Applications/Lab/Forms/HTML/frmPatient', 'Updated form behavior', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(capturedLanguage, 'GER');
  });

  test('saveItem persists a local checked-out code file through the enterprise service', async () => {
    const tempDir = path.join(__dirname, '../../..', 'out', 'test-temp', 'save-item');
    fs.mkdirSync(tempDir, { recursive: true });
    const localPath = path.join(tempDir, 'SLVSCODE', 'Applications', 'Lab', 'ServerScripts', 'scSaveMe.ssl');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, ':RETURN "saved";', 'utf8');

    let savedUri: string | undefined;
    let savedCode: string | undefined;
    let savedLanguage: string | undefined;

    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'scSaveMe',
              type: EnterpriseItemType.AppServerScript,
              uri: '/Applications/Lab/ServerScripts/scSaveMe'
            }
          ]
        }),
        saveEnterpriseItemCodeResult: async (uri, code, language) => {
          savedUri = uri;
          savedCode = code;
          savedLanguage = language;
          return { ok: true, data: '' };
        }
      }),
      {
        getDefaultFormLanguage: () => 'GER',
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.saveItem(localPath, undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(savedUri, '/Applications/Lab/ServerScripts/scSaveMe');
    assert.strictEqual(savedCode, ':RETURN "saved";');
    assert.strictEqual(savedLanguage, '');
  });

  test('saveItem requires a language for form items without defaults', async () => {
    const tempDir = path.join(__dirname, '../../..', 'out', 'test-temp', 'save-form-language');
    fs.mkdirSync(tempDir, { recursive: true });
    const localPath = path.join(tempDir, 'SLVSCODE', 'Applications', 'Lab', 'HTMLForms', 'CodeBehind', 'frmPatient.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'function test() { return true; }', 'utf8');

    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemsResult: async () => ({
          ok: true,
          data: [
            {
              name: 'frmPatient',
              type: EnterpriseItemType.HTMLFormCode,
              uri: '/Applications/Lab/HTMLForms/CodeBehind/frmPatient'
            }
          ]
        })
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.saveItem(localPath, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.requiresLanguage, true);
  });

  test('readLog returns the last N lines and reports the actual tail length', async () => {
    const allLines = ['a', 'b', 'c', 'd', 'e'];
    const requestedLastLines: Array<number | undefined> = [];
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemCodeResult: async (_uri: string, _language: string | undefined, lastLines?: number) => {
          requestedLastLines.push(lastLines);
          return {
            ok: true,
            data: { code: allLines.join('\r\n'), language: '' }
          };
        }
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.readLog('DC', 2);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.totalLines, allLines.length);
    assert.strictEqual(result.numLastLines, 2);
    assert.strictEqual(result.code, 'd\ne');
    assert.deepStrictEqual(requestedLastLines, [2]);
  });

  test('readLog passes the default line cap to the backend when lastLines is omitted', async () => {
    const requestedLastLines: Array<number | undefined> = [];
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemCodeResult: async (_uri: string, _language: string | undefined, lastLines?: number) => {
          requestedLastLines.push(lastLines);
          return {
            ok: true,
            data: { code: 'only line\r\n', language: '' }
          };
        }
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.readLog('DC');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.numLastLines, 1);
    assert.deepStrictEqual(requestedLastLines, [20]);
  });

  test('readLog does not echo the requested cap when it exceeds total lines', async () => {
    const logLines = ['line-a', 'line-b'];
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemCodeResult: async () => ({
          ok: true,
          data: { code: logLines.join('\r\n'), language: '' }
        })
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.readLog('DC', 100000);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.numLastLines, logLines.length);
    assert.strictEqual(result.totalLines, logLines.length);
  });

  test('readLog surfaces the backend "no log file" message as a failure', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemCodeResult: async () => ({
          ok: true,
          data: { code: 'There is no log file on 07.27.2026 for user Nobody !\n', language: '' }
        })
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.readLog('Nobody');
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /no log file exists/i);
    assert.strictEqual(result.user, 'Nobody');
    assert.strictEqual(result.uri, '/ServerLogs/Nobody.log');
  });

  test('listCheckedOutItems caps results and reports the total count', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock(),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined,
        listCheckedOutItems: async (includeAllUsers: boolean) => [
          { name: 'scAddCase', type: 'APPSS', uri: '/Applications/Mod/CaseMgmt/ServerScripts/scAddCase', checkedOutBy: 'DC' },
          { name: 'frmScan', type: 'HTMLFORMXML', uri: '/Applications/Scan/HTMLForms/XML/frmScan', checkedOutBy: includeAllUsers ? 'MHINZE' : 'DC', language: 'GER' }
        ]
      }
    );

    const result = await automationService.listCheckedOutItems(true, 1);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.includeAllUsers, true);
    assert.strictEqual((result.items as unknown[]).length, 1);
    assert.strictEqual(result.totalItems, 2);
    assert.strictEqual(result.truncated, true);
    assert.match(String(result.note), /limited/i);
  });

  test('listCheckedOutItems reports when listing is unavailable', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock(),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.listCheckedOutItems(false, undefined);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /not available/i);
  });

  test('transferItems rejects an empty target server name', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock(),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined,
        transferToServer: async () => ({ ok: true, targetServer: 'PROD' })
      }
    );

    const result = await automationService.transferItems('   ', true);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /cannot be empty/i);
  });

  test('transferItems reports when transfer is unavailable', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock(),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.transferItems('PROD', true);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /not available/i);
    assert.strictEqual(result.targetServer, 'PROD');
  });

  test('transferItems delegates to the configured transfer callback', async () => {
    let receivedSaveLocalEdits: boolean | undefined;
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock(),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined,
        transferToServer: async (targetServer: string, saveLocalEdits: boolean) => {
          receivedSaveLocalEdits = saveLocalEdits;
          return {
            ok: true,
            targetServer,
            sourceServer: 'QA',
            totalItems: 3,
            importLog: 'Import finished successfully.'
          };
        }
      }
    );

    const result = await automationService.transferItems('PROD', false);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.targetServer, 'PROD');
    assert.strictEqual(result.totalItems, 3);
    assert.strictEqual(receivedSaveLocalEdits, false);
  });

  test('transferItems defaults saveLocalEdits to false when omitted', async () => {
    let receivedSaveLocalEdits: boolean | undefined;
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock(),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined,
        transferToServer: async (targetServer: string, saveLocalEdits: boolean) => {
          receivedSaveLocalEdits = saveLocalEdits;
          return { ok: true, targetServer, sourceServer: 'QA', totalItems: 1 };
        }
      }
    );

    const result = await automationService.transferItems('PROD', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.targetServer, 'PROD');
    assert.strictEqual(receivedSaveLocalEdits, false);
  });

  test('createItem aborts when addItem fails instead of continuing to checkout', async () => {
    let checkoutCalled = false;
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        addItemResult: async () => ({ ok: false, error: "Application not found: BMBH_Modules.NoSuchApp" }),
        checkOutItemResult: async () => {
          checkoutCalled = true;
          return { ok: true, data: true };
        }
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.createItem('dsBroken', 'APPDS', 'SQL', 'BMBH_Modules', 'NoSuchApp');
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /Application not found: BMBH_Modules.NoSuchApp/);
    assert.strictEqual(checkoutCalled, false);
  });

  test('createItem rejects an unsupported item type before it reaches the server', async () => {
    let addCalled = false;
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        addItemResult: async () => {
          addCalled = true;
          return { ok: true, data: "added" };
        }
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.createItem('frmBroken', 'HTMLFORMCODE', 'GER', 'BMBH_Modules', 'BMBH_Ticketmanagement');
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /Unsupported item type "HTMLFORMCODE"/i);
    assert.match(String(result.error), /HTMLFORMXML/);
    assert.strictEqual(addCalled, false);
  });

  test('createItem creates an application without a checkout and reports its uri', async () => {
    let checkoutCalled = false;
    let receivedType: string | undefined;
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        addItemResult: async (_name, itemType) => {
          receivedType = itemType;
          return { ok: true, data: "added" };
        },
        checkOutItemResult: async () => {
          checkoutCalled = true;
          return { ok: true, data: true };
        }
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.createItem('MyNewApp', 'APP', 'N/A', 'BMBH_Modules', 'N/A');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(receivedType, 'APP');
    assert.strictEqual(result.uri, '/Applications/BMBH_Modules/MyNewApp');
    assert.strictEqual(checkoutCalled, false);
  });

  test('createItem checks out global code items inside their category folder', async () => {
    const checkoutUris: string[] = [];
    const localCopyUris: string[] = [];
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        checkOutItemResult: async (uri) => {
          checkoutUris.push(uri);
          return { ok: true, data: true };
        },
        getLocalCopyResult: async (uri) => {
          localCopyUris.push(uri);
          return {
            ok: true,
            data: {
              code: '',
              language: 'SSL',
              localFilePath: path.join('C:/workspace/SLVSCODE', 'QA', 'ServerScripts', 'BMBH_Plates', 'item.ssl')
            }
          };
        }
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const script = await automationService.createItem('scCheckContainerMove', 'SS', 'SSL', 'BMBH_Plates', 'N/A');
    const dataSource = await automationService.createItem('dsPlates', 'DS', 'SQL', 'BMBH_Plates', 'N/A');
    const clientScript = await automationService.createItem('csPlates', 'CS', 'JS', 'BMBH_Plates', 'N/A');

    assert.strictEqual(script.ok, true);
    assert.strictEqual(script.uri, '/ServerScripts/BMBH_Plates/scCheckContainerMove');
    assert.strictEqual(dataSource.ok, true);
    assert.strictEqual(dataSource.uri, '/DataSources/BMBH_Plates/dsPlates');
    assert.strictEqual(clientScript.ok, true);
    assert.strictEqual(clientScript.uri, '/ClientScripts/BMBH_Plates/csPlates');
    // the category segment is what ParseURI turns into type SS/DS/CS - without it the
    // checkout silently matched no case and the local sync failed
    assert.deepStrictEqual(checkoutUris, [
      '/ServerScripts/BMBH_Plates/scCheckContainerMove',
      '/DataSources/BMBH_Plates/dsPlates',
      '/ClientScripts/BMBH_Plates/csPlates'
    ]);
    assert.deepStrictEqual(localCopyUris, checkoutUris);
  });

  test('createItem keeps script categories as two-component URIs', async () => {
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock(),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.createItem('BMBH_Plates', 'SSCAT', 'N/A', 'N/A', 'N/A');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.uri, '/ServerScripts/BMBH_Plates');
  });

  test('createItem normalizes the item type to upper case for the server', async () => {
    let receivedType: string | undefined;
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        addItemResult: async (_name, itemType) => {
          receivedType = itemType;
          return { ok: true, data: "added" };
        }
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.createItem('dsLower', 'appds', 'N/A', 'BMBH_Modules', 'BMBH_Ticketmanagement');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(receivedType, 'APPDS');
  });

  test('createItem defaults data source language to SQL when N/A is passed', async () => {
    let receivedLanguage: string | undefined;
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        addItemResult: async (_name, _type, language) => {
          receivedLanguage = language;
          return { ok: true, data: "added" };
        }
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.createItem('dsNew', 'APPDS', 'N/A', 'BMBH_Modules', 'BMBH_Ticketmanagement');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(receivedLanguage, 'SQL');
    assert.match(String(result.note), /SQL/);
  });

  test('createItem defaults server script language to SSL when N/A is passed', async () => {
    let receivedLanguage: string | undefined;
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        addItemResult: async (_name, _type, language) => {
          receivedLanguage = language;
          return { ok: true, data: "added" };
        }
      }),
      {
        getDefaultFormLanguage: () => undefined,
        getMaxCodeCharacters: () => 20000,
        getMaxItems: () => 100,
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE',
        refreshCheckoutTree: async () => undefined
      }
    );

    const result = await automationService.createItem('scNew', 'APPSS', 'N/A', 'BMBH_Modules', 'BMBH_Ticketmanagement');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(receivedLanguage, 'SSL');
  });

  test('listTickets filters by the current user case-insensitively', async () => {
    const automationService = createTicketAutomationService({
      getCurrentUser: () => 'doellinger',
      getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS })
    });

    const result = await automationService.listTickets({ mine: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result.tickets as TicketOverview[]).length, 1);
    assert.strictEqual((result.tickets as TicketOverview[])[0].id, 13);
  });

  test('listTickets matches status names without requiring umlauts', async () => {
    const automationService = createTicketAutomationService({
      getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS })
    });

    const result = await automationService.listTickets({ status: 'In Pruefung' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result.tickets as TicketOverview[]).length, 1);
    assert.strictEqual((result.tickets as TicketOverview[])[0].id, 13);
  });

  test('listTickets filters titles and caps the result', async () => {
    const automationService = createTicketAutomationService({
      getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS })
    });

    const filtered = await automationService.listTickets({ titleContains: 'füllmengen' });
    assert.strictEqual(filtered.ok, true);
    assert.strictEqual((filtered.tickets as TicketOverview[]).length, 1);
    assert.strictEqual((filtered.tickets as TicketOverview[])[0].id, 12);

    const capped = await automationService.listTickets({ maxItems: 1 });
    assert.strictEqual((capped.tickets as TicketOverview[]).length, 1);
    assert.strictEqual(capped.totalItems, 3);
    assert.strictEqual(capped.truncated, true);
  });

  test('listTickets rejects mine without a configured user', async () => {
    const automationService = createTicketAutomationService({
      getCurrentUser: () => '',
      getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS })
    });

    const result = await automationService.listTickets({ mine: true });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /no STARLIMS user is configured/i);
  });

  test('getTicketDetails truncates long text fields', async () => {
    const automationService = createTicketAutomationService({
      getTicketFullInfo: async () => ({
        comments: '',
        description: 'x'.repeat(500),
        stackTrace: ''
      }),
      getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS })
    });

    const result = await automationService.getTicketDetails(12, 20);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.description, 'x'.repeat(20));
    assert.strictEqual(result.truncated, true);
    assert.strictEqual((result.ticket as TicketOverview).id, 12);
  });

  test('getTicketDetails reports unknown tickets instead of returning empty data', async () => {
    const automationService = createTicketAutomationService({
      getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS })
    });

    const result = await automationService.getTicketDetails(9999);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /not found/i);
  });

  test('getTicketHistory caps the number of change entries', async () => {
    const automationService = createTicketAutomationService({
      getTicketHistoryResult: async () => ({
        ok: true,
        data: [
          { changedField: 'STATUS', newValue: '3', oldValue: '1' },
          { changedField: 'TITLE', newValue: 'New', oldValue: 'Old' },
          { changedField: 'PRIORITY', newValue: '4', oldValue: '1' }
        ]
      })
    });

    const result = await automationService.getTicketHistory(12, 2);
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result.entries as unknown[]).length, 2);
    assert.strictEqual(result.totalItems, 3);
    assert.strictEqual(result.truncated, true);
  });

  test('getTicketMeasures caps the number of measures', async () => {
    const automationService = createTicketAutomationService({
      getTicketMeasuresResult: async () => ({
        ok: true,
        data: [
          { dateFinished: '2026-10-16 09:26:36.360', description: 'd3', id: 495, status: 'Completed', ticketId: 12, title: 'Analyse' },
          { dateFinished: '2026-10-16 09:26:30.187', description: 'd2', id: 494, status: 'Completed', ticketId: 12, title: 'Datenkorrektur' },
          { dateFinished: '2026-10-16 09:26:29.870', description: 'd1', id: 492, status: 'Completed', ticketId: 12, title: 'Code-Fix' }
        ]
      })
    });

    const result = await automationService.getTicketMeasures(12, 2);
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result.measures as unknown[]).length, 2);
    assert.strictEqual(result.totalItems, 3);
    assert.strictEqual(result.truncated, true);
    assert.match(String(result.note), /limited to 2 of 3 measures/i);
  });

  test('getTicketMeasures reports tickets without measures', async () => {
    const automationService = createTicketAutomationService({
      getTicketMeasuresResult: async () => ({ ok: true, data: [] })
    });

    const result = await automationService.getTicketMeasures(13);
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result.measures as unknown[]).length, 0);
    assert.strictEqual(result.totalItems, 0);
    assert.match(String(result.note), /No measures are recorded for ticket #13/);
  });

  test('getTicketMeasures points at the SCM_API backend when the read fails', async () => {
    const automationService = createTicketAutomationService({
      getTicketMeasuresResult: async () => ({ ok: false, error: 'Could not execute remote script.' })
    });

    const result = await automationService.getTicketMeasures(12);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /Could not execute remote script\./);
    assert.match(String(result.error), /GetTicketMeasures/);
  });

  test('getTicketMeasures rejects a missing ticket id', async () => {
    const automationService = createTicketAutomationService();

    const result = await automationService.getTicketMeasures(0);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /positive ticket id/i);
  });

  test('undertakeTicket assigns the configured user by default', async () => {
    let receivedTicketId = 0;
    let receivedUser = '';
    const automationService = createTicketAutomationService({
      getCurrentUser: () => 'DC',
      getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS }),
      setTicketInProgressResult: async (ticketId, username) => {
        receivedTicketId = ticketId;
        receivedUser = username;
        return { ok: true, data: true };
      }
    });

    const result = await automationService.undertakeTicket(12);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(receivedTicketId, 12);
    assert.strictEqual(receivedUser, 'DC');
    assert.strictEqual(result.statusName, 'In Bearbeitung');
    assert.strictEqual(result.warning, undefined);
  });

  test('undertakeTicket warns when the ticket was assigned to someone else', async () => {
    const automationService = createTicketAutomationService({
      getCurrentUser: () => 'DC',
      getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS }),
      setTicketInProgressResult: async () => ({ ok: true, data: true })
    });

    const result = await automationService.undertakeTicket(13);
    assert.strictEqual(result.ok, true);
    assert.match(String(result.warning), /previously assigned to DOELLINGER/);
  });

  test('releaseTicket refuses foreign assignees unless forced', async () => {
    let releaseCalls = 0;
    const automationService = createTicketAutomationService({
      getCurrentUser: () => 'DC',
      getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS }),
      setTicketOpenResult: async () => {
        releaseCalls += 1;
        return { ok: true, data: true };
      }
    });

    const refused = await automationService.releaseTicket(13);
    assert.strictEqual(refused.ok, false);
    assert.match(String(refused.error), /force: true/);
    assert.strictEqual(releaseCalls, 0);

    const forced = await automationService.releaseTicket(13, true);
    assert.strictEqual(forced.ok, true);
    assert.strictEqual(releaseCalls, 1);
    assert.strictEqual(forced.statusName, 'Offen');
    assert.match(String(forced.warning), /although it was assigned to DOELLINGER/);
  });

  test('createTicket resolves type and priority names through the lookup', async () => {
    let receivedArgs: { priority: number; type: number; user: string } | undefined;
    const automationService = createTicketAutomationService({
      createTicketResult: async (username, _title, _description, typeCode, priorityCode) => {
        receivedArgs = { priority: priorityCode, type: typeCode, user: username };
        return { ok: true, data: 2220 };
      },
      getCurrentUser: () => 'DC',
      getTicketLookupDataResult: async () => ({ ok: true, data: SAMPLE_TICKET_LOOKUP })
    });

    const result = await automationService.createTicket({ description: 'Text', priority: 'hoch', title: 'Neues Ticket', type: 'bug' });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(receivedArgs, { priority: 4, type: 1, user: 'DC' });
    assert.strictEqual(result.ticketId, 2220);
    assert.deepStrictEqual(result.type, { code: 1, name: 'Bug' });
  });

  test('createTicket lists the valid types when a name is unknown', async () => {
    const automationService = createTicketAutomationService({
      getCurrentUser: () => 'DC',
      getTicketLookupDataResult: async () => ({ ok: true, data: SAMPLE_TICKET_LOOKUP })
    });

    const result = await automationService.createTicket({ title: 'Neues Ticket', type: 'Incident' });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /Unknown ticket type 'Incident'/);
    assert.match(String(result.error), /Support-Anfrage \(4\)/);
  });

  test('createTicket falls back to server defaults without consulting the lookup', async () => {
    let lookupCalled = false;
    let receivedArgs: { notify: boolean; priority: number; type: number } | undefined;
    const automationService = createTicketAutomationService({
      createTicketResult: async (_user, _title, _description, typeCode, priorityCode, notifyUser) => {
        receivedArgs = { notify: notifyUser, priority: priorityCode, type: typeCode };
        return { ok: true, data: 2221 };
      },
      getCurrentUser: () => 'DC',
      getTicketLookupDataResult: async () => {
        lookupCalled = true;
        return { ok: false, error: 'unsupported' };
      }
    });

    const result = await automationService.createTicket({ description: 'Beschreibung', title: 'Ohne Typ' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(lookupCalled, false);
    assert.deepStrictEqual(receivedArgs, { notify: false, priority: 1, type: 4 });
    assert.strictEqual(result.note, undefined);
  });

  test('createTicket mentions the AI description job when no description is given', async () => {
    const automationService = createTicketAutomationService({
      createTicketResult: async () => ({ ok: true, data: 2222 }),
      getCurrentUser: () => 'DC'
    });

    const result = await automationService.createTicket({ title: 'Nur Titel' });
    assert.strictEqual(result.ok, true);
    assert.match(String(result.note), /AI job/i);
  });

  test('checkinItem creates a ticket measure for the active ticket', async () => {
    let measureArgs: { description: string; ticketId: number; title: string } | undefined;
    const automationService = createTicketAutomationService(
      {
        checkInItem: async () => true,
        addTicketMeasureResult: async (ticketId, title, description) => {
          measureArgs = { description, ticketId, title };
          return { ok: true, data: 77 };
        },
        getCurrentUser: () => 'DC',
        getEnterpriseItemsResult: async () => ({ ok: true, data: [] })
      },
      { getActiveTicket: () => ({ id: 12, title: 'Falsche Füllmengen im Kollektiv' }) }
    );

    const result = await automationService.checkinItem('/ServerScripts/BMBH/scTest', 'Fix rounding of volumes\n\nDetails', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.measureId, 77);
    assert.strictEqual(result.ticketId, 12);
    assert.strictEqual(measureArgs?.ticketId, 12);
    assert.strictEqual(measureArgs?.title, 'Fix rounding of volumes');
    assert.match(String(measureArgs?.description), /scTest/);
    assert.match(String(result.note), /Created ticket measure 77/);
  });

  test('checkinItem keeps a successful check-in when the measure fails', async () => {
    const automationService = createTicketAutomationService(
      {
        checkInItem: async () => true,
        addTicketMeasureResult: async () => ({ ok: false, error: 'measure insert rejected' }),
        getCurrentUser: () => 'DC',
        getEnterpriseItemsResult: async () => ({ ok: true, data: [] })
      },
      { getActiveTicket: () => ({ id: 12, title: 'Ticket' }) }
    );

    const result = await automationService.checkinItem('/ServerScripts/BMBH/scTest', 'Fixed it', undefined);
    assert.strictEqual(result.ok, true);
    assert.match(String(result.measureError), /measure insert rejected/);
    assert.match(String(result.note), /could not be created/);
    assert.strictEqual(result.measureId, undefined);
  });

  test('checkinItem ticketId 0 skips the measure even with an active ticket', async () => {
    let measureCalls = 0;
    const automationService = createTicketAutomationService(
      {
        checkInItem: async () => true,
        addTicketMeasureResult: async () => {
          measureCalls += 1;
          return { ok: true, data: 1 };
        },
        getCurrentUser: () => 'DC',
        getEnterpriseItemsResult: async () => ({ ok: true, data: [] })
      },
      { getActiveTicket: () => ({ id: 12, title: 'Ticket' }) }
    );

    const result = await automationService.checkinItem('/ServerScripts/BMBH/scTest', 'Fixed it', undefined, 0);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(measureCalls, 0);
    assert.match(String(result.note), /No ticket measure was created/);
  });

  test('setActiveTicket validates the ticket and persists the selection', async () => {
    const setterCalls: Array<TicketReference | undefined> = [];
    const automationService = createTicketAutomationService(
      {
        getTicketsResult: async () => ({ ok: true, data: SAMPLE_TICKETS })
      },
      {
        setActiveTicket: async (ticket) => {
          setterCalls.push(ticket);
        }
      }
    );

    const missing = await automationService.setActiveTicket(9999);
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(setterCalls.length, 0);

    const selected = await automationService.setActiveTicket(12);
    assert.strictEqual(selected.ok, true);
    assert.strictEqual(setterCalls[0]?.id, 12);
    assert.strictEqual(setterCalls[0]?.title, 'Falsche Füllmengen im Kollektiv');

    const cleared = await automationService.setActiveTicket();
    assert.strictEqual(cleared.ok, true);
    assert.strictEqual(cleared.cleared, true);
    assert.strictEqual(setterCalls[1], undefined);
  });

  test('getActiveTicket reports the workspace selection', async () => {
    const withTicket = createTicketAutomationService({}, { getActiveTicket: () => ({ id: 13, title: 'Ticket' }) });
    const withoutTicket = createTicketAutomationService({});

    const selected = withTicket.getActiveTicket();
    assert.strictEqual(selected.ok, true);
    assert.strictEqual((selected.activeTicket as TicketReference).id, 13);

    const none = withoutTicket.getActiveTicket();
    assert.strictEqual(none.ok, true);
    assert.strictEqual(none.activeTicket, undefined);
    assert.match(String(none.note), /set_active_ticket/);
  });

  test('addTicketComment defaults the author to the configured user', async () => {
    let receivedAuthor: string | undefined;
    const automationService = createTicketAutomationService({
      getCurrentUser: () => 'DC',
      insertTicketCommentResult: async (_ticketId, _comment, author) => {
        receivedAuthor = author;
        return { ok: true, data: true };
      }
    });

    const result = await automationService.addTicketComment(12, 'Work in progress');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(receivedAuthor, 'DC');
    assert.strictEqual(result.author, 'DC');
  });

  test('getTicketComments caps the number of comments', async () => {
    const automationService = createTicketAutomationService({
      getTicketCommentsResult: async () => ({
        ok: true,
        data: [
          { author: 'DC', createdOn: '2026-10-16 09:26:30.347', id: 1209, text: 'erster', ticketId: 12 },
          { author: 'opencode', createdOn: '2026-10-16 16:07:21.820', id: 1210, text: 'zweiter', ticketId: 12 }
        ]
      })
    });

    const result = await automationService.getTicketComments(12, 1);
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result.comments as unknown[]).length, 1);
    assert.strictEqual(result.totalItems, 2);
    assert.strictEqual(result.truncated, true);
    assert.match(String(result.note), /limited to 1 of 2 comments/i);
  });

  test('getTicketComments points at the SCM_API backend when the read fails', async () => {
    const automationService = createTicketAutomationService({
      getTicketCommentsResult: async () => ({ ok: false, error: 'Could not execute remote script.' })
    });

    const result = await automationService.getTicketComments(12);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /Could not execute remote script\./);
    assert.match(String(result.error), /GetTicketComments/);
  });

  test('getTicketComments rejects a missing ticket id', async () => {
    const automationService = createTicketAutomationService();

    const result = await automationService.getTicketComments(0);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /positive ticket id/i);
  });

  test('updateTicketMeasure sends the new title and description', async () => {
    let receivedArgs: { description: string | undefined; measureId: number; ticketId: number; title: string } | undefined;
    const automationService = createTicketAutomationService({
      updateTicketMeasureResult: async (ticketId, measureId, title, description) => {
        receivedArgs = { description, measureId, ticketId, title };
        return { ok: true, data: true };
      }
    });

    const result = await automationService.updateTicketMeasure(12, 495, 'Korrigierter Titel', 'Neue Beschreibung');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(receivedArgs, {
      description: 'Neue Beschreibung',
      measureId: 495,
      ticketId: 12,
      title: 'Korrigierter Titel'
    });
    assert.strictEqual(result.measureId, 495);
  });

  test('updateTicketMeasure rejects an empty title', async () => {
    const automationService = createTicketAutomationService();

    const result = await automationService.updateTicketMeasure(12, 495, '   ', 'Beschreibung');
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /title cannot be empty/i);
  });

  test('updateTicketMeasure keeps the stored description when none is given', async () => {
    let receivedDescription: string | undefined = 'not called';
    const automationService = createTicketAutomationService({
      updateTicketMeasureResult: async (_ticketId, _measureId, _title, description) => {
        receivedDescription = description;
        return { ok: true, data: true };
      }
    });

    const result = await automationService.updateTicketMeasure(12, 495, 'Neuer Titel');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(receivedDescription, undefined, 'an omitted description must not be written');
  });

  test('updateTicketMeasure reports a failed update', async () => {
    const automationService = createTicketAutomationService({
      updateTicketMeasureResult: async () => ({ ok: false, error: 'Measure not found for this ticket.' })
    });

    const result = await automationService.updateTicketMeasure(12, 495, 'Titel', 'Beschreibung');
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /Measure not found for this ticket\./);
  });

  test('deleteTicketMeasure deletes the measure of the given ticket', async () => {
    let receivedArgs: { measureId: number; ticketId: number } | undefined;
    const automationService = createTicketAutomationService({
      deleteTicketMeasureResult: async (ticketId, measureId) => {
        receivedArgs = { measureId, ticketId };
        return { ok: true, data: true };
      }
    });

    const result = await automationService.deleteTicketMeasure(12, 495);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(receivedArgs, { measureId: 495, ticketId: 12 });
    assert.strictEqual(result.measureId, 495);
  });

  test('deleteTicketMeasure rejects a missing measure id', async () => {
    const automationService = createTicketAutomationService();

    const result = await automationService.deleteTicketMeasure(12, 0);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /positive measure id/i);
  });

  test('updateTicketComment sends the new text', async () => {
    let receivedArgs: { commentId: number; text: string; ticketId: number } | undefined;
    const automationService = createTicketAutomationService({
      updateTicketCommentResult: async (ticketId, commentId, text) => {
        receivedArgs = { commentId, text, ticketId };
        return { ok: true, data: true };
      }
    });

    const result = await automationService.updateTicketComment(12, 1209, 'Korrigierter Kommentar');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(receivedArgs, { commentId: 1209, text: 'Korrigierter Kommentar', ticketId: 12 });
    assert.strictEqual(result.commentId, 1209);
  });

  test('updateTicketComment rejects empty text', async () => {
    const automationService = createTicketAutomationService();

    const result = await automationService.updateTicketComment(12, 1209, '  ');
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /text cannot be empty/i);
  });

  test('deleteTicketComment deletes the comment of the given ticket', async () => {
    let receivedArgs: { commentId: number; ticketId: number } | undefined;
    const automationService = createTicketAutomationService({
      deleteTicketCommentResult: async (ticketId, commentId) => {
        receivedArgs = { commentId, ticketId };
        return { ok: true, data: true };
      }
    });

    const result = await automationService.deleteTicketComment(12, 1209);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(receivedArgs, { commentId: 1209, ticketId: 12 });
    assert.strictEqual(result.commentId, 1209);
  });

  test('deleteTicketComment reports a failed delete', async () => {
    const automationService = createTicketAutomationService({
      deleteTicketCommentResult: async () => ({ ok: false, error: 'Comment not found for this ticket.' })
    });

    const result = await automationService.deleteTicketComment(12, 1209);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /Comment not found for this ticket\./);
  });
});