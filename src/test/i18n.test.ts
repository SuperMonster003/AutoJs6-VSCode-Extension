import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { getLanguage, normalizeLanguage, setLanguage, t } from '../i18n';

/*
 * The language override reads `l10n/bundle.l10n.<lang>.json` itself, so it can be exercised without VSCode.
 * zh-CN: 语言覆盖由模块自行读取 `l10n/bundle.l10n.<lang>.json`, 因此无需 VSCode 即可测试.
 */

const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'l10n', 'bundle.l10n.zh-cn.json'), 'utf8')) as Record<string, string>;

test('i18n: auto falls back to the English source without vscode', () => {
    setLanguage('auto');
    assert.equal(getLanguage(), 'auto');
    assert.equal(t('Yes'), 'Yes');
    assert.equal(t('Cannot listen on port {0}: {1}', 6347, 'EADDRINUSE'), 'Cannot listen on port 6347: EADDRINUSE');
});

test('i18n: zh-cn override translates through the bundle and fills placeholders', () => {
    assert.equal(setLanguage('zh-cn'), true);
    assert.equal(setLanguage('zh-cn'), false);
    assert.equal(t('Yes'), bundle['Yes']);
    assert.equal(t('Reload Window'), '重新加载窗口');
    const key = 'Cannot listen on port {0}: {1}';
    assert.equal(t(key, 6347, 'EADDRINUSE'), bundle[key].replace('{0}', '6347').replace('{1}', 'EADDRINUSE'));
    // Untranslated messages keep the source text.
    assert.equal(t('No such message {0}', 1), 'No such message 1');
    setLanguage('auto');
});

test('i18n: en override keeps the source strings', () => {
    setLanguage('en');
    assert.equal(t('Yes'), 'Yes');
    assert.equal(t('Reload Window'), 'Reload Window');
    setLanguage('auto');
});

test('i18n: unknown values normalize to auto', () => {
    assert.equal(normalizeLanguage('zh-CN'), 'auto');
    assert.equal(normalizeLanguage(undefined), 'auto');
    assert.equal(normalizeLanguage('en'), 'en');
    assert.equal(normalizeLanguage('zh-cn'), 'zh-cn');
});
