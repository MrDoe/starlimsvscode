import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { cleanUrl, isJson } from '../../utilities/miscUtils';
import { EnterpriseService } from '../../services/enterpriseService';

// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	suite('Utilities integration tests', () => {
		test('cleanUrl removes trailing slash and .lims suffix', () => {
			assert.strictEqual(cleanUrl('https://example.com/STARLIMS/'), 'https://example.com/STARLIMS');
			assert.strictEqual(cleanUrl('https://example.com/STARLIMS/STARLIMS.lims'), 'https://example.com/STARLIMS');
			assert.strictEqual(cleanUrl('https://example.com/STARLIMS'), 'https://example.com/STARLIMS');
		});

		test('isJson detects valid and invalid JSON', () => {
			assert.strictEqual(isJson('{"a":1}'), true);
			assert.strictEqual(isJson('not json'), false);
			assert.strictEqual(isJson(''), false);
		});
	});

	suite('EnterpriseService integration tests', () => {
		const fakeConfig = {
			url: 'https://test-server/STARLIMS/',
			user: 'TESTUSER',
			urlSuffix: 'lims'
		} as any;

		const fakeSecrets = {
			get: async (key: string) => 'password'
		} as any;

		function createFakeMemento() {
			const store = new Map<string, unknown>();
			return {
				get: <T>(key: string, defaultValue?: T) => (store.has(key) ? (store.get(key) as T) : defaultValue),
				update: async (key: string, value: unknown) => {
					store.set(key, value);
				}
			};
		}

		const service = new EnterpriseService(fakeConfig, fakeSecrets, createFakeMemento() as any);

		test('server config updates correctly', () => {
			service.updateServerConfig({ url: 'https://changed/STARLIMS/', urlSuffix: 'lims' }, 'MyServer');
			assert.strictEqual(service.getCurrentServerName(), 'MyServer');
			assert.strictEqual(service.getServerWorkspacePath('C:/root/SLVSCODE'), path.join('C:/root/SLVSCODE', 'MyServer'));
		});

		test('workspace path for unknown server does not append name', () => {
			const service2 = new EnterpriseService(fakeConfig, fakeSecrets, createFakeMemento() as any);
			assert.strictEqual(service2.getServerWorkspacePath('C:/root/SLVSCODE'), 'C:/root/SLVSCODE');
		});

		test('getEnterpriseItemUri strips starlims prefix and extension', () => {
			const computed = service.getEnterpriseItemUri('starlims:///C:/root/SLVSCODE/Applications/ServerScripts/mock.ssl', 'C:\\root\\SLVSCODE\\');
			assert.strictEqual(computed, '/Applications/ServerScripts/mock');
		});

		test('getUriFromLocalPath returns remote portion after SLVSCODE folder', () => {
			const converted = service.getUriFromLocalPath('C:\\root\\SLVSCODE\\Applications\\ServerScripts\\mock.ssl');
			assert.ok(converted.includes('Applications\\ServerScripts\\mock'));
		});

		test('getLocalFilePath adds correct extension and normalizes sql extension', () => {
			const localPath = service.getLocalFilePath('/Applications/ServerScripts/mock', 'C:/root/SLVSCODE', 'SQL');
			assert.ok(localPath.endsWith('mock.slsql'));
		});

		test('setCheckedOut and isCheckedOut behave properly', async () => {
			await service.setCheckedOut('/Applications/ServerScripts/mock', 'alice');
			assert.strictEqual(await service.isCheckedOut('/Applications/ServerScripts/mock'), true);
			assert.strictEqual(await service.isCheckedOut('notfound'), false);
		});

		test('fileExists returns true for existing file and false otherwise', () => {
			const tempDir = path.join(__dirname, '../../..', 'out', 'test-temp');
			if (!fs.existsSync(tempDir)) {
				fs.mkdirSync(tempDir, { recursive: true });
			}
			const testFile = path.join(tempDir, 'exists.txt');
			fs.writeFileSync(testFile, 'ok');
			assert.strictEqual(service.fileExists(testFile), true);
			assert.strictEqual(service.fileExists(path.join(tempDir, 'missing.txt')), false);
			fs.unlinkSync(testFile);
		});

		test('getLocalCopyResult keeps a checked-out local file when no sync timestamp exists yet', async () => {
			const tempDir = path.join(__dirname, '../../..', 'out', 'test-temp', 'checked-out-local');
			fs.mkdirSync(tempDir, { recursive: true });

			const localService = new EnterpriseService(fakeConfig, fakeSecrets, createFakeMemento() as any);
			const uri = '/Applications/TestApp/ServerScripts/mock';
			const localFilePath = localService.getLocalFilePath(uri, tempDir, 'SSL');
			fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
			fs.writeFileSync(localFilePath, ':RETURN "local";', 'utf8');
			await localService.setCheckedOut(uri, 'alice');

			(localService as any).getEnterpriseItemCodeResult = async () => {
				throw new Error('Remote fetch should not run when preserving the local checked-out copy.');
			};

			const result = await localService.getLocalCopyResult(uri, tempDir, 'SSL');
			assert.strictEqual(result.ok, true);
			assert.strictEqual(result.data?.code, ':RETURN "local";');
		});

		test('getLocalCopyResult keeps newer local edits after restart using persisted sync metadata', async () => {
			const tempDir = path.join(__dirname, '../../..', 'out', 'test-temp', 'persisted-sync');
			fs.mkdirSync(tempDir, { recursive: true });

			const fakeMemento = createFakeMemento() as any;
			const uri = '/Applications/TestApp/ServerScripts/persisted';
			const firstService = new EnterpriseService(fakeConfig, fakeSecrets, fakeMemento);
			(firstService as any).getEnterpriseItemCodeResult = async () => ({
				ok: true,
				data: {
					code: ':RETURN "remote";',
					language: 'SSL'
				}
			});

			const firstResult = await firstService.getLocalCopyResult(uri, tempDir, 'SSL');
			assert.strictEqual(firstResult.ok, true);

			const localFilePath = firstService.getLocalFilePath(uri, tempDir, 'SSL');
			fs.writeFileSync(localFilePath, ':RETURN "edited locally";', 'utf8');
			const newerDate = new Date(Date.now() + 2000);
			fs.utimesSync(localFilePath, newerDate, newerDate);

			const restartedService = new EnterpriseService(fakeConfig, fakeSecrets, fakeMemento);
			(restartedService as any).getEnterpriseItemCodeResult = async () => {
				throw new Error('Remote fetch should not run when the local file is newer than the persisted sync timestamp.');
			};

			const restartedResult = await restartedService.getLocalCopyResult(uri, tempDir, 'SSL');
			assert.strictEqual(restartedResult.ok, true);
			assert.strictEqual(restartedResult.data?.code, ':RETURN "edited locally";');
		});
	});
});
