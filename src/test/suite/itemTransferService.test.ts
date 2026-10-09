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
  });
});
