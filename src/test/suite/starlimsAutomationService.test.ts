import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { EnterpriseItemType } from '../../providers/enterpriseTreeDataProvider';
import { EnterpriseService } from '../../services/enterpriseService';
import { StarlimsAutomationService } from '../../services/starlimsAutomationService';

function createEnterpriseServiceMock(overrides: Partial<EnterpriseService> = {}): EnterpriseService {
  return {
    languages: [],
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
    const automationService = new StarlimsAutomationService(
      createEnterpriseServiceMock({
        getEnterpriseItemCodeResult: async () => ({
          ok: true,
          data: { code: allLines.join('\r\n'), language: '' }
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

    const result = await automationService.readLog('DC', 2);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.totalLines, allLines.length);
    assert.strictEqual(result.numLastLines, 2);
    assert.strictEqual(result.code, 'd\ne');
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
});