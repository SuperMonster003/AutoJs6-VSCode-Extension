import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectObserver } from '../sync';
import { toPosixPath } from '../protocol';

/*
 * Project synchronization: the first diff is a full archive, later diffs only carry changed files and list
 * deleted ones (issue #29). zh-CN: 项目同步: 首次为全量归档, 之后仅包含变更文件并列出已删除文件 (issue #29).
 */

function makeProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autojs6-sync-'));
    fs.writeFileSync(path.join(dir, 'project.json'), '{"name":"demo","main":"main.js"}');
    fs.writeFileSync(path.join(dir, 'main.js'), 'log(1);');
    fs.mkdirSync(path.join(dir, 'lib', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'nested', 'util.js'), 'module.exports = 1;');
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), '');
    return dir;
}

/** List zip entry names without a zip library: local file headers start with PK\x03\x04. zh-CN: 不借助 zip 库列出条目名. */
function zipEntryNames(buffer: Buffer): string[] {
    const names: string[] = [];
    let offset = 0;
    while ((offset = buffer.indexOf(Buffer.from([ 0x50, 0x4b, 0x03, 0x04 ]), offset)) >= 0) {
        const nameLength = buffer.readUInt16LE(offset + 26);
        const extraLength = buffer.readUInt16LE(offset + 28);
        names.push(buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'));
        offset += 30 + nameLength + extraLength;
    }
    return names;
}

test('ProjectObserver: full archive first, then incremental with deletions', async () => {
    const dir = makeProject();
    try {
        const filter = (relativePath: string) => !relativePath.split(/[\\/]/).includes('node_modules');
        const observer = new ProjectObserver(dir, filter);

        const first = await observer.diff();
        assert.equal(first.full, true);
        assert.deepEqual(first.deletedFiles, []);
        assert.equal(first.md5.length, 32);
        const names = zipEntryNames(first.buffer).sort();
        assert.deepEqual(names, [ 'lib/nested/util.js', 'main.js', 'project.json' ]);

        // Touch one file, delete another (in a subdirectory), and re-diff. zh-CN: 修改一个文件, 删除子目录中的另一个, 再次比较.
        await new Promise(resolve => setTimeout(resolve, 20));
        const now = new Date(Date.now() + 5_000);
        fs.utimesSync(path.join(dir, 'main.js'), now, now);
        fs.rmSync(path.join(dir, 'lib'), { recursive: true });

        const second = await observer.diff();
        assert.equal(second.full, false);
        assert.deepEqual(zipEntryNames(second.buffer), [ 'main.js' ]);
        assert.deepEqual(second.deletedFiles.map(toPosixPath), [ 'lib/nested/util.js' ]);

        // Nothing changed: empty archive, no deletions. zh-CN: 无变更: 空归档, 无删除.
        const third = await observer.diff();
        assert.equal(third.full, false);
        assert.deepEqual(zipEntryNames(third.buffer), []);
        assert.deepEqual(third.deletedFiles, []);

        // reset() forces a full archive again (Resync Project). zh-CN: reset() 后再次全量 (重新完整同步).
        observer.reset();
        const fourth = await observer.diff();
        assert.equal(fourth.full, true);
        assert.deepEqual(zipEntryNames(fourth.buffer).sort(), [ 'main.js', 'project.json' ]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
