import { spawn } from 'node:child_process';
import type { Message } from './shared';
import type { ModelTier } from './agents/roles';

// ---------------------------------------------------------------------------
// LLM バックエンド (LLM_BACKEND で切り替え可能)
// - pi:        Pi Durable のエージェントループ。ANTHROPIC_API_KEY が必須。
// - claude-cli: 公式 Claude Code を `claude -p` で呼ぶ。
//              CLAUDE_CODE_OAUTH_TOKEN (Claude Max) か ANTHROPIC_API_KEY
//              のどちらかが必要。
// 単発のテキスト生成 (ロールの発言、grilling、Outer Loop) も選択中バックエンドの
// 資格情報を使う (pi の場合は Anthropic API を直接呼ぶ)。
// ---------------------------------------------------------------------------

export type AgentBackend = 'claude-cli' | 'pi' | 'dummy';

export function agentBackend(): AgentBackend {
  const b = (process.env.LLM_BACKEND ?? '').toLowerCase();
  if (b === 'pi' || b === 'pi-durable') return 'pi';
  if (
    b === 'claude-cli' ||
    b === 'claude' ||
    b === 'claude-code' ||
    b === 'claude-p'
  ) {
    return 'claude-cli';
  }
  // 未指定時の既定は claude-cli (どちらかの資格情報があれば使える)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return 'claude-cli';
  }
  return 'dummy';
}

export function hasAnthropicApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function hasClaudeCliCredentials(): boolean {
  return Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
  );
}

/** ロールのモデル階層 (Opus / Sonnet) を実際のモデル ID にする */
export function modelFor(tier: ModelTier): string {
  return tier === 'opus'
    ? process.env.MODEL_OPUS || 'claude-opus-5-5'
    : process.env.MODEL_SONNET || 'claude-sonnet-5-5';
}

export interface GenerateInput {
  system?: string;
  messages: Message[];
  model?: string;
}

function formatTranscript(messages: Message[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`)
    .join('\n\n');
}

function runWithStdin(
  cmd: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env }, cwd: '/tmp' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // claude -p は失敗時も JSON を stdout に出すことがあるので、stdout があれば返す
      if (code === 0 || stdout.trim()) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

async function callClaudeCli(input: GenerateInput): Promise<string> {
  const args = ['-p', '--output-format', 'json'];
  const model = input.model ?? process.env.CLAUDE_MODEL;
  if (model) args.push('--model', model);
  if (input.system) args.push('--system-prompt', input.system);
  args.push(
    'Answer the latest user request in the transcript provided on stdin. ' +
      'Do not call tools. Respond with text only, in the language of the latest user message.',
  );
  // 資格情報 (OAuth トークン / API キー) の優先順位は Claude Code 側の仕様に任せる
  const stdout = await runWithStdin(
    'claude',
    args,
    formatTranscript(input.messages),
    10 * 60 * 1000,
  );
  const text = stdout.trim();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (parsed?.is_error) {
    throw new Error(String(parsed.result ?? 'claude -p failed'));
  }
  return typeof parsed?.result === 'string' ? parsed.result : text;
}

async function callAnthropicApi(input: GenerateInput): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set (required for LLM_BACKEND=pi)');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model ?? process.env.PI_MODEL_ID ?? 'claude-sonnet-4-5',
      max_tokens: 16000,
      ...(input.system ? { system: input.system } : {}),
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    }),
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(
      `Anthropic API ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`,
    );
  }
  const text = (data?.content ?? [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n');
  return text;
}

/** 単発のテキスト生成。資格情報が無い場合は、何が必要かを示すエラーを投げる */
export async function generate(input: GenerateInput): Promise<string> {
  const backend = agentBackend();
  if (backend === 'pi') return callAnthropicApi(input);
  if (backend === 'claude-cli') {
    if (!hasClaudeCliCredentials()) {
      throw new Error(
        'LLM_BACKEND=claude-cli には CLAUDE_CODE_OAUTH_TOKEN か ANTHROPIC_API_KEY が必要です',
      );
    }
    return callClaudeCli(input);
  }
  throw new Error(
    'LLM が未設定です。.env で LLM_BACKEND と資格情報を設定してください',
  );
}
