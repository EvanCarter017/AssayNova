import { readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const DEFAULT_IMAGES = 'C:\\Users\\Administrator\\Desktop\\COAs_西林瓶图片_按品名剂量';
export function parseProduct(name) {
  const special = {
    'KLOW 80mg': [['GHK-Cu', 50], ['BPC-157', 10], ['TB-500', 10], ['KPV', 10]],
    'GLOW 70mg': [['GHK-Cu', 50], ['BPC-157', 10], ['TB-500', 10]]
  };
  const components = special[name]?.map(([name, nominal]) => ({ name, nominal, unit: 'mg' })) ?? name.split(' + ').map(part => {
    const match = /^(.+?)\s+(\d+(?:\.\d+)?)\s*(mg|ml|IU)$/i.exec(part);
    if (!match) throw new Error('Product dose cannot be parsed: ' + name);
    return { name: match[1], nominal: Number(match[2]), unit: match[3].toLowerCase() === 'iu' ? 'IU' : match[3].toLowerCase() };
  });
  if (components.length < 1 || components.length > 4) throw new Error('Choose one to four components.');
  return { components, unit: new Set(components.map(item => item.unit)).size === 1 ? components[0].unit : 'mixed' };
}

export async function loadCatalog(directory) {
  const root = await realpath(directory);
  const choices = new Map();
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.png$/i.test(entry.name)) continue;
    const name = entry.name.replace(/\.png$/i, '').replace(/ \(\d+\)$/, '');
    const previous = choices.get(name);
    if (!previous || entry.name === name + '.png') choices.set(name, entry.name);
  }
  const products = [];
  for (const [name, file] of choices) {
    const imagePath = await realpath(path.join(root, file));
    if (path.dirname(imagePath) !== root) throw new Error('Image must be inside catalog root.');
    products.push({ id: createHash('sha256').update(name).digest('hex').slice(0,20), name, ...parseProduct(name), imagePath });
  }
  return products.sort((a,b) => a.name.localeCompare(b.name));
}

export function catalogDTO(product) {
  return { id: product.id, name: product.name, components: product.components, unit: product.unit, imageURL: '/images/' + product.id };
}
