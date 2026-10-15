import * as assert from 'assert';
import { EnterpriseService } from '../../services/enterpriseService';
import { findUnimportedItems, ItemTransferService } from '../../services/itemTransferService';
import { ServerConfig } from '../../providers/serverSelectorWebviewProvider';

const targetConfig = { name: 'PROD', url: 'https://prod/star' } as unknown as ServerConfig;

suite('ItemTransferService', () => {
  test('findUnimportedItems reports names the import log never mentions', () => {
    const log = [
      ' - Importing.....',
      ' - Importing category Utilities in CLIENTSCRIPTCATEGORIES',
      ' - Importing client script HTML_OkScript (Customizations layer)',
      ' - Import ended successfully.'
    ].join('\r\n');

    const unconfirmed = findUnimportedItems(log, ['HTML_OkScript', 'HTML_GenericMetadata', ' scSetMetadata ', '']);
    assert.deepStrictEqual(unconfirmed, ['HTML_GenericMetadata', 'scSetMetadata']);
  });

  test('findUnimportedItems treats a missing log as no confirmation', () => {
    assert.deepStrictEqual(findUnimportedItems(undefined, ['scX']), ['scX']);
    assert.deepStrictEqual(findUnimportedItems('', ['scX']), ['scX']);
    assert.deepStrictEqual(findUnimportedItems('whatever', []), []);
  });

  test('transferAllCheckouts flags expected items missing from the import log', async () => {
    const importLog = ' - Importing.....\r\n - Importing server script scArrived (Customizations layer)\r\n - Import ended successfully.\r\n';
    const targetService = {
      getCurrentServerName: () => 'PROD',
      importPackage: async () => ({ success: true, log: importLog })
    } as unknown as EnterpriseService;
    const sourceService = {
      getCurrentServerName: () => 'QA',
      exportAllCheckouts: async () => ({ fileName: 'CheckedOutItems_x.sdp', content: Buffer.from('zip') })
    } as unknown as EnterpriseService;

    const service = new ItemTransferService(sourceService, {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService
    });

    const result = await service.transferAllCheckouts('PROD', undefined, () => 2, () => ['scArrived', 'HTML_GenericMetadata']);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.unconfirmedItems, ['HTML_GenericMetadata']);
  });

  test('transferAllCheckouts keeps ok true when all items are confirmed', async () => {
    const importLog = ' - Importing server script scArrived (Customizations layer)\r\n - Import ended successfully.\r\n';
    const targetService = {
      getCurrentServerName: () => 'PROD',
      importPackage: async () => ({ success: true, log: importLog })
    } as unknown as EnterpriseService;
    const sourceService = {
      getCurrentServerName: () => 'QA',
      exportAllCheckouts: async () => ({ fileName: 'CheckedOutItems_x.sdp', content: Buffer.from('zip') })
    } as unknown as EnterpriseService;

    const service = new ItemTransferService(sourceService, {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService
    });

    const result = await service.transferAllCheckouts('PROD', undefined, () => 1, () => ['scArrived']);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.unconfirmedItems, []);
    assert.strictEqual(result.localSyncedFiles, undefined);
  });

  function createSyncTargetService(importLog: string) {
    const calls = {
      localCopy: [] as Array<{ uri: string; folder: string; language: string; forceRefresh: boolean | undefined }>,
      tables: [] as Array<{ uri: string; folder: string }>
    };
    const targetService = {
      getCurrentServerName: () => 'PROD',
      importPackage: async () => ({ success: true, log: importLog }),
      getServerWorkspacePath: (base: string) => `${base}/PROD`,
      getLocalCopyResult: async (uri: string, folder: string, language: string, forceRefresh?: boolean) => {
        calls.localCopy.push({ uri, folder, language, forceRefresh });
        return {
          ok: true,
          data: { code: 'x', language, localFilePath: `${folder}${uri}.${language.toLowerCase()}` }
        };
      },
      getTableLocalCopyResult: async (uri: string, folder: string) => {
        calls.tables.push({ uri, folder });
        return {
          ok: true,
          data: { code: '<table/>', language: 'XML', localFilePath: `${folder}${uri}.xml` }
        };
      }
    } as unknown as EnterpriseService;
    return { targetService, calls };
  }

  function createSyncSourceService() {
    return {
      getCurrentServerName: () => 'QA',
      exportAllCheckouts: async () => ({ fileName: 'CheckedOutItems_x.sdp', content: Buffer.from('zip') })
    } as unknown as EnterpriseService;
  }

  test('transferAllCheckouts refreshes local copies from the target after a successful import', async () => {
    const importLog = ' - Importing server script scA (Customizations layer)\r\n - Importing table tblX\r\n - Import ended successfully.\r\n';
    const { targetService, calls } = createSyncTargetService(importLog);
    const service = new ItemTransferService(createSyncSourceService(), {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService,
      getWorkspaceRoot: () => 'C:/SLVSCODE'
    });

    const result = await service.transferAllCheckouts(
      'PROD',
      undefined,
      () => 2,
      () => ['scA', 'tblX'],
      () => [
        { name: 'scA', uri: '/ServerScripts/util/scA', language: 'SSL' },
        { name: 'tblX', uri: '/DICT/tblX', isTable: true }
      ]
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.localSyncedFiles, [
      'C:/SLVSCODE/PROD/ServerScripts/util/scA.ssl',
      'C:/SLVSCODE/PROD/DICT/tblX.xml'
    ]);
    assert.strictEqual(result.localSyncErrors, undefined);
    assert.deepStrictEqual(calls.localCopy, [
      { uri: '/ServerScripts/util/scA', folder: 'C:/SLVSCODE/PROD', language: 'SSL', forceRefresh: true }
    ]);
    assert.deepStrictEqual(calls.tables, [{ uri: '/DICT/tblX', folder: 'C:/SLVSCODE/PROD' }]);
  });

  test('transferAllCheckouts skips local sync for unconfirmed items', async () => {
    const importLog = ' - Importing server script scA (Customizations layer)\r\n - Import ended successfully.\r\n';
    const { targetService, calls } = createSyncTargetService(importLog);
    const service = new ItemTransferService(createSyncSourceService(), {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService,
      getWorkspaceRoot: () => 'C:/SLVSCODE'
    });

    const result = await service.transferAllCheckouts(
      'PROD',
      undefined,
      () => 2,
      () => ['scA', 'HTML_Missing'],
      () => [
        { name: 'scA', uri: '/ServerScripts/util/scA', language: 'SSL' },
        { name: 'HTML_Missing', uri: '/Applications/App/HTMLForms/HTML_Missing', language: 'GER' }
      ]
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.unconfirmedItems, ['HTML_Missing']);
    assert.deepStrictEqual(result.localSyncedFiles, ['C:/SLVSCODE/PROD/ServerScripts/util/scA.ssl']);
    assert.strictEqual(calls.localCopy.length, 1);
    assert.strictEqual(calls.localCopy[0].uri, '/ServerScripts/util/scA');
  });

  test('transferAllCheckouts records local sync errors without failing the transfer', async () => {
    const importLog = ' - Importing server script scA (Customizations layer)\r\n - Import ended successfully.\r\n';
    const targetService = {
      getCurrentServerName: () => 'PROD',
      importPackage: async () => ({ success: true, log: importLog }),
      getServerWorkspacePath: (base: string) => `${base}/PROD`,
      getLocalCopyResult: async () => ({ ok: false, error: 'Could not retrieve item code.' })
    } as unknown as EnterpriseService;
    const service = new ItemTransferService(createSyncSourceService(), {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService,
      getWorkspaceRoot: () => 'C:/SLVSCODE'
    });

    const result = await service.transferAllCheckouts(
      'PROD',
      undefined,
      () => 1,
      () => ['scA'],
      () => [{ name: 'scA', uri: '/ServerScripts/util/scA', language: 'SSL' }]
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.localSyncedFiles, []);
    assert.deepStrictEqual(result.localSyncErrors, ['scA: Could not retrieve item code.']);
  });

  test('transferAllCheckouts skips local sync without the getWorkspaceRoot option', async () => {
    const importLog = ' - Importing server script scA (Customizations layer)\r\n - Import ended successfully.\r\n';
    const { targetService, calls } = createSyncTargetService(importLog);
    const service = new ItemTransferService(createSyncSourceService(), {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService
    });

    const result = await service.transferAllCheckouts(
      'PROD',
      undefined,
      () => 1,
      () => ['scA'],
      () => [{ name: 'scA', uri: '/ServerScripts/util/scA', language: 'SSL' }]
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.localSyncedFiles, undefined);
    assert.strictEqual(calls.localCopy.length, 0);
  });
});
