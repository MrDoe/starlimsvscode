import * as assert from 'assert';
import { EnterpriseService } from '../../services/enterpriseService';
import { findUnimportedItems, ItemTransferService } from '../../services/itemTransferService';
import { ServerConfig } from '../../providers/serverSelectorWebviewProvider';
import {
  findTransferFilterViolation,
  hasTransferFilter,
  isAllUsersTransferFilter,
  matchesTransferItemName,
  matchesTransferUser,
  normalizeTransferFilter,
  normalizeTransferItemName,
  selectTransferScope,
  stripTransferItemTypeSuffix
} from '../../services/itemTransferFilter';

const targetConfig = { name: 'PROD', url: 'https://prod/star' } as unknown as ServerConfig;

type ExportResult = {
  ok: boolean;
  data?: { fileName: string; content: Buffer; itemNames?: string[]; itemUsers?: string[] };
  error?: string;
};

function createSourceService(exportResult: ExportResult) {
  const calls = { filters: [] as unknown[] };
  const sourceService = {
    getCurrentServerName: () => 'QA',
    exportAllCheckoutsResult: async (filter?: unknown) => {
      calls.filters.push(filter);
      return exportResult;
    }
  } as unknown as EnterpriseService;
  return { sourceService, calls };
}

function createDefaultExportResult(): ExportResult {
  return {
    ok: true,
    data: { fileName: 'CheckedOutItems_x.sdp', content: Buffer.from('zip') }
  };
}

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
    const { sourceService } = createSourceService(createDefaultExportResult());

    const service = new ItemTransferService(sourceService, {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService
    });

    const result = await service.transferAllCheckouts({
      targetServer: 'PROD',
      getItemCount: () => 2,
      getExpectedItemNames: () => ['scArrived', 'HTML_GenericMetadata']
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.unconfirmedItems, ['HTML_GenericMetadata']);
  });

  test('transferAllCheckouts keeps ok true when all items are confirmed', async () => {
    const importLog = ' - Importing server script scArrived (Customizations layer)\r\n - Import ended successfully.\r\n';
    const targetService = {
      getCurrentServerName: () => 'PROD',
      importPackage: async () => ({ success: true, log: importLog })
    } as unknown as EnterpriseService;
    const { sourceService } = createSourceService(createDefaultExportResult());

    const service = new ItemTransferService(sourceService, {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService
    });

    const result = await service.transferAllCheckouts({
      targetServer: 'PROD',
      getItemCount: () => 1,
      getExpectedItemNames: () => ['scArrived']
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.unconfirmedItems, []);
    assert.strictEqual(result.localSyncedFiles, undefined);
  });

  test('transferAllCheckouts passes the filter to the source server export', async () => {
    const importLog = ' - Importing server script scA (Customizations layer)\r\n - Import ended successfully.\r\n';
    const targetService = {
      getCurrentServerName: () => 'PROD',
      importPackage: async () => ({ success: true, log: importLog })
    } as unknown as EnterpriseService;
    const { sourceService, calls } = createSourceService({
      ok: true,
      data: {
        fileName: 'CheckedOutItems_x.sdp',
        content: Buffer.from('zip'),
        itemNames: ['scA'],
        itemUsers: ['maria']
      }
    });

    const service = new ItemTransferService(sourceService, {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService
    });

    const result = await service.transferAllCheckouts({
      targetServer: 'PROD',
      filter: { user: 'maria', itemNames: ['scA'] },
      getExpectedItemNames: () => ['scA']
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls.filters, [{ user: 'maria', itemNames: ['scA'] }]);
    assert.deepStrictEqual(result.exportedItemNames, ['scA']);
    assert.deepStrictEqual(result.filter, { user: 'maria', itemNames: ['scA'] });
  });

  test('transferAllCheckouts reports the export error of a filtered transfer', async () => {
    const { sourceService } = createSourceService({
      ok: false,
      error: 'The STARLIMS server ignored the transfer filter.'
    });
    const service = new ItemTransferService(sourceService, {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => ({ getCurrentServerName: () => 'PROD' } as unknown as EnterpriseService)
    });

    const result = await service.transferAllCheckouts({
      targetServer: 'PROD',
      filter: { itemNames: ['scA'] }
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'The STARLIMS server ignored the transfer filter.');
  });

  test('transferAllCheckouts fails when no checked out item matches the filter', async () => {
    const { sourceService } = createSourceService({
      ok: true,
      data: {
        fileName: 'CheckedOutItems_x.sdp',
        content: Buffer.from('zip'),
        itemNames: [],
        itemUsers: []
      }
    });
    const service = new ItemTransferService(sourceService, {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => ({ getCurrentServerName: () => 'PROD' } as unknown as EnterpriseService)
    });

    const result = await service.transferAllCheckouts({
      targetServer: 'PROD',
      filter: { itemNames: ['scUnknown'] }
    });

    assert.strictEqual(result.ok, false);
    assert.match(String(result.error), /matched the transfer filter/i);
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
    return createSourceService(createDefaultExportResult()).sourceService;
  }

  test('transferAllCheckouts refreshes local copies from the target after a successful import', async () => {
    const importLog = ' - Importing server script scA (Customizations layer)\r\n - Importing table tblX\r\n - Import ended successfully.\r\n';
    const { targetService, calls } = createSyncTargetService(importLog);
    const service = new ItemTransferService(createSyncSourceService(), {
      getServerConfigs: () => [targetConfig],
      createTargetService: () => targetService,
      getWorkspaceRoot: () => 'C:/SLVSCODE'
    });

    const result = await service.transferAllCheckouts({
      targetServer: 'PROD',
      getItemCount: () => 2,
      getExpectedItemNames: () => ['scA', 'tblX'],
      getLocalSyncItems: () => [
        { name: 'scA', uri: '/ServerScripts/util/scA', language: 'SSL' },
        { name: 'tblX', uri: '/DICT/tblX', isTable: true }
      ]
    });

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

    const result = await service.transferAllCheckouts({
      targetServer: 'PROD',
      getItemCount: () => 2,
      getExpectedItemNames: () => ['scA', 'HTML_Missing'],
      getLocalSyncItems: () => [
        { name: 'scA', uri: '/ServerScripts/util/scA', language: 'SSL' },
        { name: 'HTML_Missing', uri: '/Applications/App/HTMLForms/HTML_Missing', language: 'GER' }
      ]
    });

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

    const result = await service.transferAllCheckouts({
      targetServer: 'PROD',
      getItemCount: () => 1,
      getExpectedItemNames: () => ['scA'],
      getLocalSyncItems: () => [{ name: 'scA', uri: '/ServerScripts/util/scA', language: 'SSL' }]
    });

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

    const result = await service.transferAllCheckouts({
      targetServer: 'PROD',
      getItemCount: () => 1,
      getExpectedItemNames: () => ['scA'],
      getLocalSyncItems: () => [{ name: 'scA', uri: '/ServerScripts/util/scA', language: 'SSL' }]
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.localSyncedFiles, undefined);
    assert.strictEqual(calls.localCopy.length, 0);
  });
});

suite('ItemTransferFilter', () => {
  test('the type suffix of the tree labels is ignored when items are compared', () => {
    assert.strictEqual(stripTransferItemTypeSuffix('frmTest [XML]'), 'frmTest');
    assert.strictEqual(stripTransferItemTypeSuffix('frmTest [Code Behind]'), 'frmTest');
    assert.strictEqual(stripTransferItemTypeSuffix('scArrived'), 'scArrived');
    assert.strictEqual(normalizeTransferItemName('frmTest [XML]'), 'frmtest');
    assert.strictEqual(normalizeTransferItemName('FRMTEST'), 'frmtest');
  });

  test('item names are matched case-insensitively and ignore the type suffix', () => {
    const filter = { itemNames: ['FRMTEST'] };
    assert.strictEqual(matchesTransferItemName('frmTest', filter), true);
    assert.strictEqual(matchesTransferItemName('frmTest [XML]', filter), true);
    assert.strictEqual(matchesTransferItemName('frmOther', filter), false);
    assert.strictEqual(matchesTransferItemName('frmTest', undefined), true);
  });

  test('the user filter matches the checkout user case-insensitively', () => {
    assert.strictEqual(matchesTransferUser('maria', { user: 'Maria' }), true);
    assert.strictEqual(matchesTransferUser('maria', { user: 'hans' }), false);
    assert.strictEqual(matchesTransferUser('maria', { user: 'all' }), true);
    assert.strictEqual(matchesTransferUser('maria', undefined), true);
    assert.strictEqual(isAllUsersTransferFilter('ALL'), true);
    assert.strictEqual(isAllUsersTransferFilter('*'), true);
    assert.strictEqual(isAllUsersTransferFilter('maria'), false);
  });

  test('an empty filter does not narrow the transfer down', () => {
    assert.strictEqual(hasTransferFilter(undefined), false);
    assert.strictEqual(hasTransferFilter({}), false);
    assert.strictEqual(hasTransferFilter({ user: '  ' }), false);
    assert.strictEqual(hasTransferFilter({ itemNames: [] }), false);
    assert.strictEqual(hasTransferFilter({ user: 'maria' }), true);
    assert.strictEqual(hasTransferFilter({ itemNames: ['scA'] }), true);
  });

  test('normalizeTransferFilter drops empty values', () => {
    assert.strictEqual(normalizeTransferFilter(undefined), undefined);
    assert.strictEqual(normalizeTransferFilter({ user: '  ', itemNames: [] }), undefined);
    assert.deepStrictEqual(normalizeTransferFilter({ user: ' maria ', itemNames: [' scA ', ''] }), {
      itemNames: ['scA'],
      user: 'maria'
    });
  });

  test('an export that ignores the filter is detected', () => {
    // The server did not report the items it exported: its backend API is too old.
    assert.match(
      String(findTransferFilterViolation({ itemNames: undefined }, { itemNames: ['scA'] })),
      /does not support filtered transfers/i
    );
    // The server exported an item that the filter does not allow.
    assert.match(
      String(findTransferFilterViolation({ itemNames: ['scOther'] }, { itemNames: ['scA'] })),
      /outside the requested filter/i
    );
    // The server exported an item of another user.
    assert.match(
      String(findTransferFilterViolation({ itemNames: ['scA'], itemUsers: ['hans'] }, { user: 'maria' })),
      /outside the requested filter/i
    );
    // Everything matches.
    assert.strictEqual(findTransferFilterViolation({ itemNames: ['scA'], itemUsers: ['maria'] }, { user: 'maria' }), undefined);
    // Without a filter nothing has to match.
    assert.strictEqual(findTransferFilterViolation({ itemNames: ['scA'] }, undefined), undefined);
  });

  test('without a filter the checkouts of the current user are the transfer scope', () => {
    const currentUserItems = [
      { label: 'scA', uri: '/ServerScripts/util/scA', checkedOutBy: 'maria' },
      { label: 'scB', uri: '/ServerScripts/util/scB', checkedOutBy: 'maria' }
    ];

    assert.deepStrictEqual(selectTransferScope(currentUserItems, undefined, undefined), currentUserItems);
    assert.deepStrictEqual(selectTransferScope(currentUserItems, undefined, {}), currentUserItems);
  });

  test('a name filter without a user filter only covers the checkouts of the current user', () => {
    // The server exports the checkouts of the current user when no user is named,
    // so the scope must not contain the items of another user.
    const currentUserItems = [
      { label: 'scA', uri: '/ServerScripts/util/scA', checkedOutBy: 'maria' }
    ];
    const allUserItems = [
      ...currentUserItems,
      { label: 'scB', uri: '/ServerScripts/util/scB', checkedOutBy: 'hans' }
    ];

    assert.deepStrictEqual(
      selectTransferScope(currentUserItems, allUserItems, { itemNames: ['scA'] }),
      [currentUserItems[0]]
    );
    // The item of the other user is not part of the scope, even by name.
    assert.deepStrictEqual(
      selectTransferScope(currentUserItems, allUserItems, { itemNames: ['scB'] }),
      []
    );
  });

  test('a user filter selects the items of that user', () => {
    const allUserItems = [
      { label: 'scA', uri: '/ServerScripts/util/scA', checkedOutBy: 'maria' },
      { label: 'scB', uri: '/ServerScripts/util/scB', checkedOutBy: 'hans' },
      { label: 'scC', uri: '/ServerScripts/util/scC', checkedOutBy: 'maria' }
    ];

    assert.deepStrictEqual(
      selectTransferScope([], allUserItems, { user: 'maria' }).map((item) => item.label),
      ['scA', 'scC']
    );
    // The checkout user is matched case-insensitively.
    assert.deepStrictEqual(
      selectTransferScope([], allUserItems, { user: 'MARIA' }).map((item) => item.label),
      ['scA', 'scC']
    );
    // "all" covers the checkouts of every user.
    assert.deepStrictEqual(
      selectTransferScope([], allUserItems, { user: 'all' }).map((item) => item.label),
      ['scA', 'scB', 'scC']
    );
    // A user filter and item names are combined.
    assert.deepStrictEqual(
      selectTransferScope([], allUserItems, { user: 'maria', itemNames: ['scC'] }).map((item) => item.label),
      ['scC']
    );
  });

  test('a user filter needs the checkouts of all users', () => {
    assert.throws(
      () => selectTransferScope([], undefined, { user: 'maria' }),
      /checkouts of all users/i
    );
  });

  test('the type suffix of the tree labels is ignored when the scope is built', () => {
    const currentUserItems = [
      { label: 'frmTest [XML]', uri: '/Applications/App/HTMLForms/XML/frmTest', checkedOutBy: 'maria' }
    ];

    assert.deepStrictEqual(
      selectTransferScope(currentUserItems, undefined, { itemNames: ['frmTest'] }),
      currentUserItems
    );
    assert.deepStrictEqual(
      selectTransferScope(currentUserItems, undefined, { itemNames: ['frmTest [XML]'] }),
      currentUserItems
    );
  });
});
