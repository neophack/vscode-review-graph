/**
 * @jest-environment jsdom
 *
 * Unit tests of the webview string dictionary (`web/strings.ts`) and the
 * `review-graph.interfaceLanguage` Extension Setting that selects it.
 *
 * The web sources are non-module scripts (concatenated into a single IIFE by the
 * production build), so this suite concatenates web/strings.ts into a generated
 * module (tests/generated/stringsBundle.ts) at runtime, mirroring
 * tests/webModules.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { getConfig } from '../src/config';

/* Build the generated module exposing the string dictionary under test */
const GENERATED_DIR = path.join(__dirname, 'generated');
if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR);
const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'strings.ts'), 'utf8');
fs.writeFileSync(
	path.join(GENERATED_DIR, 'stringsBundle.ts'),
	'/* eslint-disable */\n' +
	'// GENERATED FILE - concatenated from web/strings.ts by tests/strings.test.ts - do not edit\n' +
	'// @ts-nocheck (the concatenated source is type-checked as part of web/tsconfig.json)\n' +
	source +
	'\nfunction currentStrings() { return strings; }\n' +
	'export { getStrings, setInterfaceLanguage, formatStr, currentStrings, STRINGS_EN, STRINGS_ZH_CN };\n'
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundle: {
	getStrings: (lang: string) => { [key: string]: string };
	setInterfaceLanguage: (lang: string) => void;
	formatStr: (template: string, ...args: string[]) => string;
	currentStrings: () => { [key: string]: string };
	STRINGS_EN: { [key: string]: string };
	STRINGS_ZH_CN: { [key: string]: string };
} = require('./generated/stringsBundle');

describe('web/strings.ts', () => {
	it('Should provide identical key sets for en and zh-cn', () => {
		expect(Object.keys(bundle.STRINGS_ZH_CN).sort()).toEqual(Object.keys(bundle.STRINGS_EN).sort());
	});

	it('Should not contain empty translations', () => {
		for (const key of Object.keys(bundle.STRINGS_ZH_CN)) {
			expect(bundle.STRINGS_ZH_CN[key]).not.toBe('');
		}
	});

	it('Should return the English dictionary by default and for unknown languages', () => {
		expect(bundle.getStrings('en')).toBe(bundle.STRINGS_EN);
		expect(bundle.getStrings('zh-cn')).toBe(bundle.STRINGS_ZH_CN);
		expect(bundle.getStrings('fr')).toBe(bundle.STRINGS_EN);
		expect(bundle.getStrings(<any>undefined)).toBe(bundle.STRINGS_EN);
	});

	it('Should default to the English dictionary and switch it via setInterfaceLanguage', () => {
		expect(bundle.currentStrings()).toBe(bundle.STRINGS_EN);
		bundle.setInterfaceLanguage('zh-cn');
		expect(bundle.currentStrings()).toBe(bundle.STRINGS_ZH_CN);
		bundle.setInterfaceLanguage('en');
		expect(bundle.currentStrings()).toBe(bundle.STRINGS_EN);
	});

	it('Should substitute {0}/{1} placeholders via formatStr', () => {
		expect(bundle.formatStr(bundle.STRINGS_EN.filterTitleActive, 'src/main.ts')).toBe('Filter Commits by Path (active: src/main.ts)');
		expect(bundle.formatStr(bundle.STRINGS_ZH_CN.filterTitleActive, 'src/main.ts')).toBe('按路径过滤提交（当前：src/main.ts）');
		expect(bundle.formatStr('a {0} b {1} c {0}', '1', '2')).toBe('a 1 b 2 c 1');
	});
});

describe('Config.interfaceLanguage', () => {
	it('Should return en by default', () => {
		expect(getConfig().interfaceLanguage).toBe('en');
	});

	it('Should return zh-cn when the setting is zh-cn', () => {
		vscode.mockExtensionSettingReturnValue('interfaceLanguage', 'zh-cn');
		expect(getConfig().interfaceLanguage).toBe('zh-cn');
	});

	it('Should return en when the setting is an unexpected value', () => {
		vscode.mockExtensionSettingReturnValue('interfaceLanguage', 'fr');
		expect(getConfig().interfaceLanguage).toBe('en');
	});
});
