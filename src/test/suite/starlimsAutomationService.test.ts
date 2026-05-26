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
});