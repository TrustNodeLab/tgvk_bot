// Порт bot/astro.py на JS: реальное небо над Москвой (высота Солнца, звёзды).
// Вход — Date, чьи UTC-поля равны московскому времени (см. mskDate() в cardgen.js).

export const MOSCOW_LAT = 55.7558;
export const MOSCOW_LON = 37.6173;

// Bright star catalog: name, RA (hours), Dec (degrees), magnitude, constellation
// Real astronomical data (J2000), public-domain values.
const STARS = [
  ["Sirius", 6.7525, -16.7161, -1.46, "CMa"],
  ["Canopus", 6.3992, -52.6957, -0.74, "Car"],
  ["Arcturus", 14.261, 19.1825, -0.05, "Boo"],
  ["Vega", 18.6156, 38.7837, 0.03, "Lyr"],
  ["Capella", 5.2782, 45.998, 0.08, "Aur"],
  ["Rigel", 5.2423, -8.2016, 0.13, "Ori"],
  ["Procyon", 7.655, 5.225, 0.34, "CMi"],
  ["Betelgeuse", 5.9195, 7.4071, 0.5, "Ori"],
  ["Altair", 19.8464, 8.8683, 0.77, "Aql"],
  ["Aldebaran", 4.5987, 16.5093, 0.85, "Tau"],
  ["Antares", 16.4901, -26.432, 1.09, "Sco"],
  ["Spica", 13.4199, -11.1613, 1.04, "Vir"],
  ["Pollux", 7.7553, 28.0262, 1.14, "Gem"],
  ["Fomalhaut", 22.9608, -29.6222, 1.16, "PsA"],
  ["Deneb", 20.6905, 45.2803, 1.25, "Cyg"],
  ["Regulus", 10.1395, 11.9672, 1.35, "Leo"],
  ["Castor", 7.5766, 31.8883, 1.58, "Gem"],
  ["Polaris", 2.5303, 89.2641, 1.98, "UMi"],
  // Big Dipper / Ursa Major
  ["Dubhe", 11.0621, 61.751, 1.79, "UMa"],
  ["Merak", 11.0307, 56.3824, 2.37, "UMa"],
  ["Phecda", 11.8972, 53.6948, 2.44, "UMa"],
  ["Megrez", 12.257, 57.0326, 3.31, "UMa"],
  ["Alioth", 12.9005, 55.9598, 1.77, "UMa"],
  ["Mizar", 13.3987, 54.9254, 2.23, "UMa"],
  ["Alkaid", 13.7923, 49.3133, 1.86, "UMa"],
  // Cassiopeia
  ["Schedar", 0.6751, 56.5373, 2.24, "Cas"],
  ["Caph", 0.153, 59.1498, 2.28, "Cas"],
  ["Gamma Cas", 0.9451, 60.7167, 2.47, "Cas"],
  ["Ruchbah", 1.4303, 60.2353, 2.68, "Cas"],
  ["Segin", 1.9066, 63.6701, 3.35, "Cas"],
  // Orion
  ["Bellatrix", 5.4189, 6.3497, 1.64, "Ori"],
  ["Alnilam", 5.6036, -1.2019, 1.69, "Ori"],
  ["Alnitak", 5.6793, -1.9426, 1.88, "Ori"],
  ["Mintaka", 5.5334, -0.2991, 2.23, "Ori"],
  ["Saiph", 5.7959, -9.6696, 2.09, "Ori"],
  // Cygnus (Northern Cross)
  ["Sadr", 20.3705, 40.2567, 2.23, "Cyg"],
  ["Gienah Cyg", 20.7702, 33.9702, 2.46, "Cyg"],
  ["Delta Cyg", 19.7497, 45.131, 2.87, "Cyg"],
  ["Albireo", 19.512, 27.9597, 3.18, "Cyg"],
  // Lyra
  ["Sheliak", 18.8347, 33.3627, 3.52, "Lyr"],
  ["Sulafat", 18.9825, 32.6896, 3.24, "Lyr"],
  // Cepheus / misc north
  ["Alderamin", 21.3097, 62.5856, 2.44, "Cep"],
  ["Kochab", 14.8451, 74.1555, 2.07, "UMi"],
];

export const CONSTELLATION_LINES = {
  UMa: [["Alkaid", "Mizar"], ["Mizar", "Alioth"], ["Alioth", "Megrez"],
    ["Megrez", "Phecda"], ["Phecda", "Merak"], ["Merak", "Dubhe"], ["Dubhe", "Megrez"]],
  Cas: [["Caph", "Schedar"], ["Schedar", "Gamma Cas"], ["Gamma Cas", "Ruchbah"], ["Ruchbah", "Segin"]],
  Ori: [["Bellatrix", "Mintaka"], ["Mintaka", "Alnilam"], ["Alnilam", "Alnitak"],
    ["Betelgeuse", "Alnilam"], ["Alnitak", "Saiph"], ["Bellatrix", "Betelgeuse"],
    ["Mintaka", "Rigel"], ["Rigel", "Saiph"]],
  Cyg: [["Deneb", "Sadr"], ["Sadr", "Delta Cyg"], ["Delta Cyg", "Albireo"], ["Sadr", "Gienah Cyg"]],
  Lyr: [["Vega", "Sheliak"], ["Sheliak", "Sulafat"], ["Sulafat", "Vega"]],
};

function julianDate(dtUtc) {
  let y = dtUtc.getUTCFullYear();
  let m = dtUtc.getUTCMonth() + 1;
  const d = dtUtc.getUTCDate();
  const h = dtUtc.getUTCHours() + dtUtc.getUTCMinutes() / 60 + dtUtc.getUTCSeconds() / 3600;
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const jd = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + h / 24 + B - 1524.5;
  return jd;
}

function gmstHours(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000.0;
  gmst = ((gmst % 360) + 360) % 360;
  return gmst / 15.0;
}

function lstHours(dtUtc, lonDeg) {
  return (((gmstHours(julianDate(dtUtc)) + lonDeg / 15.0) % 24) + 24) % 24;
}

function altaz(raH, decDeg, lstH, latDeg) {
  const H = (lstH - raH) * 15.0;
  const Hr = H * Math.PI / 180;
  const dcr = decDeg * Math.PI / 180;
  const ltr = latDeg * Math.PI / 180;
  const sinAlt = Math.sin(dcr) * Math.sin(ltr) + Math.cos(dcr) * Math.cos(ltr) * Math.cos(Hr);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180 / Math.PI;
  const cosAz = (Math.sin(dcr) - Math.sin(alt * Math.PI / 180) * Math.sin(ltr)) /
    (Math.cos(alt * Math.PI / 180) * Math.cos(ltr) + 1e-9);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * 180 / Math.PI;
  if (Math.sin(Hr) > 0) az = 360 - az;
  return [alt, az];
}

function sunPosition(dtUtc) {
  const jd = julianDate(dtUtc);
  const n = jd - 2451545.0;
  const L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360 + 360) % 360 * Math.PI / 180;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = (23.439 - 0.0000004 * n) * Math.PI / 180;
  let ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * 180 / Math.PI / 15.0;
  ra = ((ra % 24) + 24) % 24;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)) * 180 / Math.PI;
  return [ra, dec];
}

// dtMsk — Date, чьи UTC-поля = московское время (картинка выше).
export function sunAltitudeMoscow(dtMsk) {
  const dtUtc = new Date(dtMsk.getTime() - 3 * 3600 * 1000);
  const lst = lstHours(dtUtc, MOSCOW_LON);
  const [ra, dec] = sunPosition(dtUtc);
  const [alt] = altaz(ra, dec, lst, MOSCOW_LAT);
  return alt;
}

export function starsMoscow(dtMsk) {
  const dtUtc = new Date(dtMsk.getTime() - 3 * 3600 * 1000);
  const lst = lstHours(dtUtc, MOSCOW_LON);
  const out = [];
  for (const [name, ra, dec, mag, con] of STARS) {
    const [alt, az] = altaz(ra, dec, lst, MOSCOW_LAT);
    out.push([name, alt, az, mag, con]);
  }
  return out;
}
