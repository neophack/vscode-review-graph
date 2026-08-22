import { mocks } from '../mocks/vscode';

export function expectExtensionSettingToHaveBeenCalled(section: string) {
	expect(mocks.workspaceConfiguration.get).toBeCalledWith(section, expect.anything());
}

export function waitForExpect(expect: () => void) {
	return new Promise((resolve, reject) => {
		let attempts = 0;
		const testInterval = setInterval(() => {
			try {
				attempts++;
				expect();
				resolve();
			} catch (e) {
				if (attempts === 100) {
					clearInterval(testInterval);
					reject(e);
				}
			}
		}, 20);
	});
}
