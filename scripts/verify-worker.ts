import worker from '../src/index';
import yaml from 'js-yaml';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const memory = new Map<string, string>();
const env = {
  SUB_CACHE: {
    get: async (key: string) => memory.get(key) ?? null,
    put: async (key: string, value: string) => { memory.set(key, value); },
    delete: async (key: string) => { memory.delete(key); }
  }
} as any;

async function main() {
  const configResponse = await worker.fetch(
    new Request('https://worker.example/config/edt2-cf-sg-us.ini'),
    env
  );
  assert(configResponse.status === 200, 'built-in config endpoint failed');
  assert((await configResponse.text()).includes('🇸🇬 新加坡均衡'), 'built-in config content is incomplete');

  const uuid = '11111111-1111-4111-8111-111111111111';
  const links = [
    `vless://${uuid}@sg.example.com:443?encryption=none&security=tls&type=ws#${encodeURIComponent('🇸🇬 Singapore 01')}`,
    `vless://${uuid}@us.example.com:443?encryption=none&security=tls&type=ws#${encodeURIComponent('🇺🇸 Los Angeles LAX')}`,
    `vless://${uuid}@au.example.com:443?encryption=none&security=tls&type=ws#${encodeURIComponent('🇦🇺 Australia Sydney')}`,
    `vless://${uuid}@jp.example.com:443?encryption=none&security=tls&type=ws#${encodeURIComponent('🇯🇵 Tokyo JP')}`
  ].join('|');
  const configUrl = encodeURIComponent('https://worker.example/config/edt2-cf-sg-us.ini');
  const requestUrl = `https://worker.example/sub?target=clash&config=${configUrl}&url=${encodeURIComponent(links)}`;
  const response = await worker.fetch(new Request(requestUrl), env);
  const body = await response.text();
  assert(response.status === 200, `worker conversion failed: ${body}`);

  const config = yaml.load(body) as Record<string, any>;
  const groups = config['proxy-groups'] as Array<Record<string, any>>;
  const singapore = groups.find(group => group.name === '🇸🇬 新加坡手选');
  const unitedStates = groups.find(group => group.name === '🇺🇸 美国手选');
  assert(singapore, 'generated config is missing Singapore group');
  assert(unitedStates, 'generated config is missing United States group');
  assert(JSON.stringify(singapore.proxies) === JSON.stringify(['🇸🇬 Singapore 01']), 'Singapore group matched wrong nodes');
  assert(JSON.stringify(unitedStates.proxies) === JSON.stringify(['🇺🇸 Los Angeles LAX']), 'United States group matched wrong nodes');
  assert(Object.keys(config['rule-providers'] || {}).length === 50, 'generated rule providers are incomplete');
  assert((config.rules as string[]).at(-1) === 'MATCH,🐟 漏网之鱼', 'final routing rule is incorrect');

  console.log(JSON.stringify({
    status: response.status,
    proxies: (config.proxies as unknown[]).length,
    groups: groups.length,
    ruleProviders: Object.keys(config['rule-providers']).length,
    singapore: singapore.proxies,
    unitedStates: unitedStates.proxies
  }, null, 2));
}

main();
