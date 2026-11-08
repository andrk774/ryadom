export function distanceKm(lat1, lon1, lat2, lon2) {
  if ([lat1,lon1,lat2,lon2].some(v=>v === null || !Number.isFinite(Number(v)))) return null;
  const rad = x => Number(x)*Math.PI/180;
  const a = Math.sin(rad(lat2-lat1)/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(rad(lon2-lon1)/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0,1-a)));
}
export function locationFields(input, fail) {
  const district = typeof input.district === 'string' ? input.district.trim() : '';
  if (district.length > 80) fail(400,'Район: до 80 символов');
  const present = v => v !== undefined && v !== null && v !== '';
  if (!present(input.latitude) && !present(input.longitude)) return {district,latitude:null,longitude:null};
  if (!present(input.latitude) || !present(input.longitude) || !['string','number'].includes(typeof input.latitude) || !['string','number'].includes(typeof input.longitude)) fail(400,'Укажите широту и долготу');
  const latitude=Number(input.latitude),longitude=Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude)>90 || Math.abs(longitude)>180) fail(400,'Некорректные координаты');
  return {district,latitude:Math.round(latitude*100)/100,longitude:Math.round(longitude*100)/100};
}
