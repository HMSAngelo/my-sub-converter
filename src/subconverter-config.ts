import { Env, ProxyNode } from './types';
import { DEFAULT_EDT_CONFIG } from './default-config';

export type CustomGroupType = 'select' | 'url-test' | 'fallback' | 'load-balance';

export interface CustomProxyGroup {
  name: string;
  type: CustomGroupType;
  references: string[];
  pattern?: string;
  testUrl?: string;
  interval: number;
  tolerance?: number;
}

export interface CustomRuleSet {
  policy: string;
  source: string;
}

export interface ParsedSubconverterConfig {
  groups: CustomProxyGroup[];
  ruleSets: CustomRuleSet[];
  settings: Record<string, string>;
}

const BUILTIN_ALIASES = new Set(['default', 'builtin', 'edt2-sg-us', 'edt2_cf_sg_us']);
const BUILTIN_PATH = '/config/edt2-cf-sg-us.ini';

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseGroup(value: string, lineNumber: number): CustomProxyGroup {
  const fields = value.split('`');
  const name = (fields.shift() || '').trim();
  const rawType = (fields.shift() || '').trim().toLowerCase();
  const supported = ['select', 'url-test', 'fallback', 'load-balance'];

  if (!name || !supported.includes(rawType)) {
    throw new Error(`外部配置第 ${lineNumber} 行的 custom_proxy_group 无效`);
  }

  const type = rawType as CustomGroupType;
  const references: string[] = [];
  const plainFields: string[] = [];

  for (const field of fields) {
    const trimmed = field.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[]')) references.push(trimmed.slice(2).trim());
    else plainFields.push(trimmed);
  }

  if (type === 'select') {
    return {
      name,
      type,
      references: unique(references),
      pattern: plainFields[0],
      interval: 300
    };
  }

  const timing = (plainFields[2] || '').split(',');
  return {
    name,
    type,
    references: unique(references),
    pattern: plainFields[0],
    testUrl: plainFields[1] || 'http://www.gstatic.com/generate_204',
    interval: positiveNumber(timing[0], 300),
    tolerance: positiveNumber(timing[2], 50)
  };
}

export function parseSubconverterConfig(text: string): ParsedSubconverterConfig {
  if (!text || !text.trim()) throw new Error('外部配置文件为空');

  const groups: CustomProxyGroup[] = [];
  const ruleSets: CustomRuleSet[] = [];
  const settings: Record<string, string> = {};
  let inCustomSection = false;

  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) return;
    if (line.startsWith('[') && line.endsWith(']')) {
      inCustomSection = line.toLowerCase() === '[custom]';
      return;
    }
    if (!inCustomSection) return;

    const equals = line.indexOf('=');
    if (equals < 1) return;
    const key = line.slice(0, equals).trim().toLowerCase();
    const value = line.slice(equals + 1).trim();

    if (key === 'custom_proxy_group') {
      groups.push(parseGroup(value, index + 1));
    } else if (key === 'ruleset') {
      const comma = value.indexOf(',');
      if (comma < 1) throw new Error(`外部配置第 ${index + 1} 行的 ruleset 无效`);
      ruleSets.push({ policy: value.slice(0, comma).trim(), source: value.slice(comma + 1).trim() });
    } else {
      settings[key] = value;
    }
  });

  if (groups.length === 0) throw new Error('外部配置没有 custom_proxy_group，无法生成动态分组');
  return { groups, ruleSets, settings };
}

function normalizeGithubUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === 'github.com') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const blobIndex = parts.indexOf('blob');
      if (blobIndex === 2 && parts.length > 4) {
        return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`;
      }
    }
  } catch {}
  return value;
}

async function shortHash(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function isBuiltinConfig(source: string | null | undefined, origin?: string): boolean {
  const trimmed = (source || '').trim();
  if (!trimmed || BUILTIN_ALIASES.has(trimmed.toLowerCase())) return true;
  try {
    const configUrl = new URL(trimmed, origin);
    return Boolean(origin && configUrl.origin === origin && configUrl.pathname === BUILTIN_PATH);
  } catch {
    return false;
  }
}

export async function loadSubconverterConfig(
  source: string | null | undefined,
  env?: Env,
  forceRefresh = false,
  origin?: string
): Promise<ParsedSubconverterConfig> {
  if (isBuiltinConfig(source, origin)) return parseSubconverterConfig(DEFAULT_EDT_CONFIG);

  const normalized = normalizeGithubUrl((source || '').trim());
  let configUrl: URL;
  try {
    configUrl = new URL(normalized);
  } catch {
    throw new Error('config 必须是 http/https 配置地址，或使用 edt2-sg-us');
  }
  if (configUrl.protocol !== 'http:' && configUrl.protocol !== 'https:') {
    throw new Error('config 只支持 http/https 地址');
  }

  const cacheKey = `external-config:${await shortHash(configUrl.toString())}`;
  if (!forceRefresh && env?.SUB_CACHE) {
    const cached = await env.SUB_CACHE.get(cacheKey);
    if (cached) return parseSubconverterConfig(cached);
  }

  if (forceRefresh) configUrl.searchParams.set('_edt_refresh', String(Date.now()));
  const response = await fetch(configUrl.toString(), {
    headers: {
      'User-Agent': 'my-sub-converter/EDT2',
      Accept: 'text/plain,text/*;q=0.9,*/*;q=0.1'
    }
  });
  if (!response.ok) throw new Error(`读取外部配置失败: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('外部配置超过 1 MiB，已拒绝处理');

  const parsed = parseSubconverterConfig(text);
  if (env?.SUB_CACHE) {
    await env.SUB_CACHE.put(cacheKey, text, { expirationTtl: 3600 });
  }
  return parsed;
}

function compilePattern(pattern: string | undefined, groupName: string): RegExp | null {
  if (!pattern) return null;
  const normalized = pattern.replace(/^\(\?i\)/, '');
  try {
    return new RegExp(normalized, 'i');
  } catch {
    throw new Error(`策略组“${groupName}”的节点正则无效: ${pattern}`);
  }
}

function membersForGroup(group: CustomProxyGroup, nodeNames: string[]): string[] {
  const matcher = compilePattern(group.pattern, group.name);
  const matched = matcher ? nodeNames.filter(name => matcher.test(name)) : [];
  const members = unique([...group.references, ...matched]);
  return members.length > 0 ? members : ['DIRECT'];
}

export function createClashGroups(parsed: ParsedSubconverterConfig, nodes: ProxyNode[]): Array<Record<string, unknown>> {
  const nodeNames = nodes.map(node => node.name);
  return parsed.groups.map(group => {
    const output: Record<string, unknown> = {
      name: group.name,
      type: group.type,
      proxies: membersForGroup(group, nodeNames)
    };
    if (group.type !== 'select') {
      output.url = group.testUrl;
      output.interval = group.interval;
      output.lazy = true;
      if (group.type === 'url-test') output.tolerance = group.tolerance;
      if (group.type === 'load-balance') output.strategy = 'consistent-hashing';
    }
    return output;
  });
}

function providerName(source: string, index: number): string {
  let base = `ruleset-${index + 1}`;
  try {
    const file = decodeURIComponent(new URL(source).pathname.split('/').pop() || '');
    base = file.replace(/\.(list|txt|ya?ml)$/i, '') || base;
  } catch {}
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `ruleset-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${slug}`;
}

export function createClashRules(parsed: ParsedSubconverterConfig): {
  providers: Record<string, Record<string, unknown>>;
  rules: string[];
} {
  const providers: Record<string, Record<string, unknown>> = {};
  const rules: string[] = [];

  parsed.ruleSets.forEach((ruleSet, index) => {
    const source = ruleSet.source.trim();
    if (source.startsWith('[]')) {
      const inlineRule = source.slice(2);
      const keyword = inlineRule.split(',', 1)[0].toUpperCase();
      if (keyword === 'FINAL' || keyword === 'MATCH') rules.push(`MATCH,${ruleSet.policy}`);
      else if (keyword === 'GEOIP') rules.push(`${inlineRule},${ruleSet.policy},no-resolve`);
      else rules.push(`${inlineRule},${ruleSet.policy}`);
      return;
    }

    if (!/^https?:\/\//i.test(source)) return;
    const name = providerName(source, index);
    providers[name] = {
      type: 'http',
      behavior: 'classical',
      format: 'text',
      url: source,
      path: `./ruleset/${name}.list`,
      interval: 86400
    };
    rules.push(`RULE-SET,${name},${ruleSet.policy}`);
  });

  return { providers, rules };
}

export function createSingBoxGroups(parsed: ParsedSubconverterConfig, nodes: ProxyNode[]): Array<Record<string, unknown>> {
  const nodeNames = nodes.map(node => node.name);
  return parsed.groups.map(group => {
    const type = group.type === 'select' ? 'selector' : 'urltest';
    const output: Record<string, unknown> = {
      type,
      tag: group.name,
      outbounds: membersForGroup(group, nodeNames)
    };
    if (type === 'urltest') {
      output.url = group.testUrl;
      output.interval = `${group.interval}s`;
      output.tolerance = group.tolerance;
    }
    return output;
  });
}

export { BUILTIN_PATH };
