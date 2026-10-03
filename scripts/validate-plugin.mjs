import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { URL } from 'node:url';
import console from 'node:console';
const root = resolve('plugin');
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name) || manifest.name.length > 64)
  throw new Error('Invalid package name.');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid release version.');
const ui = manifest.extensions?.['com.openai']?.interface;
if (!ui?.displayName || ui.shortDescription.length > 30)
  throw new Error('Invalid plugin presentation.');
for (const property of ['logo', 'composerIcon']) {
  const asset = resolve(root, ui[property]);
  if (!asset.startsWith(root + '\\') && !asset.startsWith(root + '/'))
    throw new Error('Asset escapes package.');
  if ((await stat(asset)).size > 10240) throw new Error('Icon exceeds UI limit.');
}
const connection = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
for (const value of Object.values(connection.mcpServers)) {
  if (value.type !== 'streamable-http' || new URL(value.url).hostname !== 'gateway.example.com')
    throw new Error('Public package must contain only the generic self-hosted template.');
}
for (const name of await readdir(join(root, 'skills'))) {
  const skill = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
  if (!skill.includes(`name: ${name}`) || !skill.includes('description:'))
    throw new Error('Invalid skill metadata.');
}
console.log('Plugin template, contained assets, icon limit and skill metadata: PASS');
