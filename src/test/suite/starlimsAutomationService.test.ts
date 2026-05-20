import * as assert from 'assert';
import * as path from 'path';
import { EnterpriseItemType } from '../../providers/enterpriseTreeDataProvider';
import { EnterpriseService } from '../../services/enterpriseService';
import { StarlimsAutomationService } from '../../services/starlimsAutomationService';

function createEnterpriseServiceMock(overrides: Partial<EnterpriseService> = {}): EnterpriseService {
  return {
    languages: [],
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
    searchForItemsResult: async () => ({ ok: true, data: [] }),
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
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE'
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
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE'
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
        getWorkspaceRoot: () => 'C:/workspace/SLVSCODE'
      }
    );

    const result = await automationService.checkoutItem('/Applications/Lab/Forms/HTML/frmPatient', undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(capturedLanguage, 'GER');
    assert.strictEqual(result.language, 'GER');
  });
});