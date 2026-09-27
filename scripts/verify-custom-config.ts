import { DEFAULT_EDT_CONFIG } from '../src/default-config';
import {
  createClashGroups,
  createClashRules,
  createSingBoxGroups,
  parseSubconverterConfig
} from '../src/subconverter-config';
import { ProxyNode } from '../src/types';

const node = (name: string): ProxyNode => ({
  type: 'vless',
  name,
  server: 'example.com',
  port: 443
});

const nodes = [
  node('🇸🇬 Singapore 01'),
  node('狮城 SG-02'),
  node('🇺🇸 Los Angeles LAX'),
  node('美国 US-02'),
  node('🇦🇺 Australia Sydney'),
  node('🇯🇵 Tokyo JP')
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const equal = (actual: unknown, expected: unknown, message: string) => {
  assert(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
};

const deepEqual = (actual: unknown, expected: unknown, message: string) => {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
};

const parsed = parseSubconverterConfig(DEFAULT_EDT_CONFIG);
const clashGroups = createClashGroups(parsed, nodes);
const singBoxGroups = createSingBoxGroups(parsed, nodes);
const generatedRules = createClashRules(parsed);

const group = (name: string) => {
  const found = clashGroups.find(item => item.name === name);
  assert(found, `missing group: ${name}`);
  return found;
};

deepEqual(group('🇸🇬 新加坡手选').proxies, ['🇸🇬 Singapore 01', '狮城 SG-02'], 'Singapore matching failed');
deepEqual(group('🇺🇸 美国手选').proxies, ['🇺🇸 Los Angeles LAX', '美国 US-02'], 'United States matching failed');
equal(group('🇸🇬 新加坡均衡').type, 'load-balance', 'Singapore load-balance type');
equal(group('🇺🇸 美国均衡').type, 'load-balance', 'United States load-balance type');
equal(group('♻️ 自动测速').type, 'url-test', 'url-test type');
equal(group('🔯 故障转移').type, 'fallback', 'fallback type');
assert((group('☑️ 手动选择').proxies as string[]).includes('🇯🇵 Tokyo JP'), 'manual group must include all nodes');
assert(generatedRules.rules.some(rule => rule === 'MATCH,🐟 漏网之鱼'), 'missing MATCH rule');
assert(generatedRules.rules.some(rule => rule.startsWith('GEOIP,CN,🎯 全球直连')), 'missing GEOIP rule');
assert(Object.keys(generatedRules.providers).length > 40, 'too few rule providers');
equal(singBoxGroups.find(item => item.tag === '🇸🇬 新加坡手选')?.type, 'selector', 'Sing-box select type');
equal(singBoxGroups.find(item => item.tag === '🇺🇸 美国均衡')?.type, 'urltest', 'Sing-box urltest type');

const policyNames = new Set(parsed.groups.map(item => item.name));
for (const item of parsed.ruleSets) {
  assert(policyNames.has(item.policy), `ruleset references missing group: ${item.policy}`);
}

console.log(JSON.stringify({
  groups: parsed.groups.length,
  ruleSets: parsed.ruleSets.length,
  providers: Object.keys(generatedRules.providers).length,
  singapore: group('🇸🇬 新加坡手选').proxies,
  unitedStates: group('🇺🇸 美国手选').proxies
}, null, 2));
