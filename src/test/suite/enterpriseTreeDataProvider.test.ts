import * as assert from 'assert';
import { EnterpriseTreeDataProvider } from '../../providers/enterpriseTreeDataProvider';

suite('EnterpriseTreeDataProvider integration tests', () => {
	test('builds search results when the server returns URI instead of uri', async () => {
			const searchResult: any = {
				name: 'MyScript',
				type: 'APPSS',
				checkedOutBy: undefined,
				language: 'SSL',
				isFolder: false,
				guid: '123'
			};
			searchResult.URI = '/Applications/DemoApp/Scripts/ServerScripts/MyScript';

		const provider = new EnterpriseTreeDataProvider({
			getConfig: () => ({
				get: (key: string) => (key === 'user' ? 'TESTUSER' : undefined)
			}),
			globalSearch: async () => ([
					searchResult
			]),
			searchForItems: async () => []
		} as any);

		await provider.search('MyScript', '', false, true);

		const rootItems = await provider.getChildren();
		assert.strictEqual(String(rootItems[0].label), 'Applications');
		assert.ok(rootItems[0].children);
		assert.strictEqual(String(rootItems[0].children?.[0].label), 'DemoApp');
		assert.strictEqual(String(rootItems[0].children?.[0].children?.[0].label), 'Scripts');
	});
});