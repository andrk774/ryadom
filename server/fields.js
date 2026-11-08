export const FIELDS = {
  transport: [
    { id: 'brand', name: 'Марка', type: 'text', maxLength: 50 },
    { id: 'year', name: 'Год выпуска', type: 'number', min: 1900, max: new Date().getFullYear() + 1 },
    { id: 'mileage', name: 'Пробег, км', type: 'number', min: 0, max: 5000000 },
  ],
  realty: [
    { id: 'area', name: 'Площадь, м²', type: 'number', min: 1, max: 1000000, step: 0.1 },
    { id: 'rooms', name: 'Комнаты', type: 'select', options: ['Студия', '1', '2', '3', '4', '5+'] },
    { id: 'deal', name: 'Тип предложения', type: 'select', options: ['Продажа', 'Аренда'] },
  ],
  clothes: [
    { id: 'size', name: 'Размер', type: 'text', maxLength: 20 },
    { id: 'brand', name: 'Бренд', type: 'text', maxLength: 50 },
  ],
  electronics: [{ id: 'brand', name: 'Бренд', type: 'text', maxLength: 50 }, { id: 'model', name: 'Модель', type: 'text', maxLength: 60 }],
};

export function validateAttributes(category, input, fail) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Некорректные характеристики');
  const result = {};
  for (const field of FIELDS[category] || []) {
    let v = input[field.id];
    if (v === '' || v === null || v === undefined) continue;
    if (field.type === 'number') {
      if (!['number', 'string'].includes(typeof v)) fail(400, `Некорректное поле: ${field.name}`);
      v = Number(v);
      if (!Number.isFinite(v) || v < field.min || v > field.max || (!field.step && !Number.isInteger(v))) fail(400, `Некорректное поле: ${field.name}`);
    } else {
      if (typeof v !== 'string') fail(400, `Некорректное поле: ${field.name}`);
      v = v.trim();
      if (v.length > (field.maxLength || 60) || (field.options && !field.options.includes(v))) fail(400, `Некорректное поле: ${field.name}`);
    }
    result[field.id] = v;
  }
  return result;
}

// Used by both the feed and saved-search matching, with whitelisted JSON paths.
export function listingFilters(query, alias = 'l') {
  const where = [], args = [];
  const text = s => String(s).toLowerCase().replaceAll('ё', 'е');
  if (query.get('district')) { where.push(`${alias}.district = ?`); args.push(query.get('district').trim()); }
  if (query.get('lat') !== null && query.get('lon') !== null && query.get('radius')) {
    const [lat,lon,radius] = ['lat','lon','radius'].map(k=>Number(query.get(k)));
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180 && radius>0 && radius<=500) {
      where.push(`distance_km(?, ?, ${alias}.latitude, ${alias}.longitude) <= ?`); args.push(lat,lon,radius);
    } else { where.push('0 = 1'); }
  }
  for (const word of text(query.get('q') || '').split(/\s+/).filter(Boolean).slice(0, 8)) {
    where.push(`${alias}.search_text LIKE ? ESCAPE '\\'`);
    args.push(`%${word.replace(/[\\%_]/g, '\\$&')}%`);
  }
  for (const field of ['category', 'city', 'condition', 'seller']) {
    if (query.get(field)) { where.push(`${alias}.${field === 'seller' ? 'user_id' : field} = ?`); args.push(query.get(field)); }
  }
  for (const [key, op] of [['min', '>='], ['max', '<=']]) {
    if (query.get(key) !== null && query.get(key) !== '' && Number.isFinite(Number(query.get(key)))) {
      where.push(`${alias}.price ${op} ?`); args.push(Number(query.get(key)));
    }
  }
  for (const field of FIELDS[query.get('category')] || []) {
    const json = `json_extract(${alias}.attributes, '$.${field.id}')`;
    for (const [key, op] of field.type === 'number' ? [[`attr_${field.id}_min`, '>='], [`attr_${field.id}_max`, '<=']] : [[`attr_${field.id}`, '=']]) {
      const value = query.get(key);
      if (value === null || value === '') continue;
      if (field.type === 'number') {
        if (!Number.isFinite(Number(value))) continue;
        where.push(`${json} ${op} ?`); args.push(Number(value));
      } else { where.push(`${json} = ? COLLATE NOCASE`); args.push(value.trim()); }
    }
  }
  return { where, args };
}
