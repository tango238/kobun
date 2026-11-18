// リポジトリの読み取り: タグの解釈、パスの対応づけ、サンドボックス側の拒否
import { describe, expect, it } from 'vitest';
import { parseOutput } from '../src/agents/protocol';
import { repoContainerPath } from '../src/org-activities';
// @ts-expect-error サンドボックスのデーモンは型定義のない .mjs
import { isSecretPath, repoOp } from '../../sandbox/repo-access.mjs';

describe('リポジトリを読むタグ', () => {
  it('一覧・検索・読み取りを解釈する', () => {
    const p = parseOutput(
      [
        '<repo-list repo="backend"/>',
        '<repo-grep repo="backend" pattern="invoice_items?" path="app/models"/>',
        '<repo-read repo="backend" path="app/models/item.rb" from="40" lines="80"/>',
      ].join('\n'),
    );
    expect(p.repoOps).toEqual([
      { op: 'list', repo: 'backend', path: '.' },
      { op: 'grep', repo: 'backend', path: 'app/models', pattern: 'invoice_items?' },
      { op: 'read', repo: 'backend', path: 'app/models/item.rb', from: 40, lines: 80 },
    ]);
  });

  it('リポジトリの外を指すパス、パターンのない検索、パスのない読み取りは捨てる', () => {
    const p = parseOutput(
      [
        '<repo-read repo="backend" path="../../etc/passwd"/>',
        '<repo-read repo="backend" path="/etc/passwd"/>',
        '<repo-grep repo="backend"/>',
        '<repo-read repo="backend"/>',
      ].join('\n'),
    );
    expect(p.repoOps).toEqual([]);
  });
});

describe('ホストのパスとサンドボックスのパスの対応', () => {
  const host = '/home/dev/work/client-a';
  it('REPOS_DIR の下にあるリポジトリだけ読める', () => {
    expect(repoContainerPath('/home/dev/work/client-a/backend-repo', host)).toBe('/repos/backend-repo');
    expect(repoContainerPath('/home/dev/work/client-a/backend-repo/', host)).toBe('/repos/backend-repo');
    expect(repoContainerPath('/home/dev/work/other/x', host)).toBeNull();
    expect(repoContainerPath('/home/dev/work/client-a-secret/x', host)).toBeNull();
    expect(repoContainerPath('/home/dev/work/client-a/../secret', host)).toBeNull();
    expect(repoContainerPath('https://github.com/o/r', host)).toBeNull();
  });
  it('REPOS_DIR が未設定なら何も読めない', () => {
    expect(repoContainerPath('/home/dev/work/client-a/backend-repo', '')).toBeNull();
  });
});

describe('サンドボックス側の拒否', () => {
  it('資格情報を含みうるファイルは読ませない', () => {
    for (const p of [
      '.env',
      '.env.local',
      'config/.env.production',
      'deploy/id_rsa',
      'certs/server.pem',
      '.git/config',
      '.aws/credentials',
      'config/credentials.yml.enc',
      'infra/terraform.tfstate',
      'infra/prod.tfvars',
      '.npmrc',
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
  });

  it('通常のコードと、値の入っていない .env の見本は読める', () => {
    for (const p of [
      '.env.example',
      'src/env.ts',
      'app/models/secret_santa.rb',
      '.github/workflows/ci.yml',
      '.gitignore',
      'docs/keys.md',
    ]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });

  it('/repos の外を指すルートは拒否する', async () => {
    expect(await repoOp({ op: 'list', root: '/etc' })).toEqual({
      error: 'このリポジトリは読み取り用にマウントされていません',
    });
    expect((await repoOp({ op: 'read', root: '/repos/../etc', path: 'passwd' })).error).toBeTruthy();
  });
});
