import math
from datetime import datetime, timedelta

MOSCOW_LAT = 55.7558
MOSCOW_LON = 37.6173

# Bright star catalog: name, RA (hours), Dec (degrees), magnitude, constellation
# Real astronomical data (J2000), public-domain values.
STARS = [
    ("Sirius", 6.7525, -16.7161, -1.46, "CMa"),
    ("Canopus", 6.3992, -52.6957, -0.74, "Car"),
    ("Arcturus", 14.2610, 19.1825, -0.05, "Boo"),
    ("Vega", 18.6156, 38.7837, 0.03, "Lyr"),
    ("Capella", 5.2782, 45.9980, 0.08, "Aur"),
    ("Rigel", 5.2423, -8.2016, 0.13, "Ori"),
    ("Procyon", 7.6550, 5.2250, 0.34, "CMi"),
    ("Betelgeuse", 5.9195, 7.4071, 0.50, "Ori"),
    ("Altair", 19.8464, 8.8683, 0.77, "Aql"),
    ("Aldebaran", 4.5987, 16.5093, 0.85, "Tau"),
    ("Antares", 16.4901, -26.4320, 1.09, "Sco"),
    ("Spica", 13.4199, -11.1613, 1.04, "Vir"),
    ("Pollux", 7.7553, 28.0262, 1.14, "Gem"),
    ("Fomalhaut", 22.9608, -29.6222, 1.16, "PsA"),
    ("Deneb", 20.6905, 45.2803, 1.25, "Cyg"),
    ("Regulus", 10.1395, 11.9672, 1.35, "Leo"),
    ("Castor", 7.5766, 31.8883, 1.58, "Gem"),
    ("Polaris", 2.5303, 89.2641, 1.98, "UMi"),
    # Big Dipper / Ursa Major
    ("Dubhe", 11.0621, 61.7510, 1.79, "UMa"),
    ("Merak", 11.0307, 56.3824, 2.37, "UMa"),
    ("Phecda", 11.8972, 53.6948, 2.44, "UMa"),
    ("Megrez", 12.2570, 57.0326, 3.31, "UMa"),
    ("Alioth", 12.9005, 55.9598, 1.77, "UMa"),
    ("Mizar", 13.3987, 54.9254, 2.23, "UMa"),
    ("Alkaid", 13.7923, 49.3133, 1.86, "UMa"),
    # Cassiopeia
    ("Schedar", 0.6751, 56.5373, 2.24, "Cas"),
    ("Caph", 0.1530, 59.1498, 2.28, "Cas"),
    ("Gamma Cas", 0.9451, 60.7167, 2.47, "Cas"),
    ("Ruchbah", 1.4303, 60.2353, 2.68, "Cas"),
    ("Segin", 1.9066, 63.6701, 3.35, "Cas"),
    # Orion
    ("Bellatrix", 5.4189, 6.3497, 1.64, "Ori"),
    ("Alnilam", 5.6036, -1.2019, 1.69, "Ori"),
    ("Alnitak", 5.6793, -1.9426, 1.88, "Ori"),
    ("Mintaka", 5.5334, -0.2991, 2.23, "Ori"),
    ("Saiph", 5.7959, -9.6696, 2.09, "Ori"),
    # Cygnus (Northern Cross)
    ("Sadr", 20.3705, 40.2567, 2.23, "Cyg"),
    ("Gienah Cyg", 20.7702, 33.9702, 2.46, "Cyg"),
    ("Delta Cyg", 19.7497, 45.1310, 2.87, "Cyg"),
    ("Albireo", 19.5120, 27.9597, 3.18, "Cyg"),
    # Lyra
    ("Sheliak", 18.8347, 33.3627, 3.52, "Lyr"),
    ("Sulafat", 18.9825, 32.6896, 3.24, "Lyr"),
    # Cepheus / misc north
    ("Alderamin", 21.3097, 62.5856, 2.44, "Cep"),
    ("Kochab", 14.8451, 74.1555, 2.07, "UMi"),
]

CONSTELLATION_LINES = {
    "UMa": [("Alkaid","Mizar"),("Mizar","Alioth"),("Alioth","Megrez"),
            ("Megrez","Phecda"),("Phecda","Merak"),("Merak","Dubhe"),("Dubhe","Megrez")],
    "Cas": [("Caph","Schedar"),("Schedar","Gamma Cas"),("Gamma Cas","Ruchbah"),("Ruchbah","Segin")],
    "Ori": [("Bellatrix","Mintaka"),("Mintaka","Alnilam"),("Alnilam","Alnitak"),
            ("Betelgeuse","Alnilam"),("Alnitak","Saiph"),("Bellatrix","Betelgeuse"),
            ("Mintaka","Rigel"),("Rigel","Saiph")],
    "Cyg": [("Deneb","Sadr"),("Sadr","Delta Cyg"),("Delta Cyg","Albireo"),("Sadr","Gienah Cyg")],
    "Lyr": [("Vega","Sheliak"),("Sheliak","Sulafat"),("Sulafat","Vega")],
}

def julian_date(dt_utc):
    y, m, d = dt_utc.year, dt_utc.month, dt_utc.day
    h = dt_utc.hour + dt_utc.minute/60 + dt_utc.second/3600
    if m <= 2:
        y -= 1
        m += 12
    A = y // 100
    B = 2 - A + A // 4
    jd = int(365.25*(y+4716)) + int(30.6001*(m+1)) + d + h/24 + B - 1524.5
    return jd

def gmst_hours(jd):
    T = (jd - 2451545.0) / 36525.0
    gmst = 280.46061837 + 360.98564736629*(jd - 2451545.0) + 0.000387933*T*T - T*T*T/38710000.0
    gmst = gmst % 360.0
    return gmst / 15.0  # hours

def lst_hours(dt_utc, lon_deg):
    jd = julian_date(dt_utc)
    gmst = gmst_hours(jd)
    lst = (gmst + lon_deg/15.0) % 24.0
    return lst

def altaz(ra_h, dec_deg, lst_h, lat_deg):
    H = (lst_h - ra_h) * 15.0  # hour angle in degrees
    H_rad = math.radians(H)
    dec_rad = math.radians(dec_deg)
    lat_rad = math.radians(lat_deg)
    sin_alt = math.sin(dec_rad)*math.sin(lat_rad) + math.cos(dec_rad)*math.cos(lat_rad)*math.cos(H_rad)
    alt = math.degrees(math.asin(max(-1,min(1,sin_alt))))
    cos_az = (math.sin(dec_rad) - math.sin(math.radians(alt))*math.sin(lat_rad)) / (math.cos(math.radians(alt))*math.cos(lat_rad) + 1e-9)
    az = math.degrees(math.acos(max(-1,min(1,cos_az))))
    if math.sin(H_rad) > 0:
        az = 360 - az
    return alt, az

def sun_position(dt_utc):
    jd = julian_date(dt_utc)
    n = jd - 2451545.0
    L = (280.460 + 0.9856474*n) % 360
    g = math.radians((357.528 + 0.9856003*n) % 360)
    lam = math.radians(L + 1.915*math.sin(g) + 0.020*math.sin(2*g))
    eps = math.radians(23.439 - 0.0000004*n)
    ra = math.degrees(math.atan2(math.cos(eps)*math.sin(lam), math.cos(lam))) / 15.0
    ra = ra % 24
    dec = math.degrees(math.asin(math.sin(eps)*math.sin(lam)))
    return ra, dec

def sun_altitude_moscow(dt_msk):
    dt_utc = dt_msk - timedelta(hours=3)
    lst = lst_hours(dt_utc, MOSCOW_LON)
    ra, dec = sun_position(dt_utc)
    alt, az = altaz(ra, dec, lst, MOSCOW_LAT)
    return alt

def stars_moscow(dt_msk):
    dt_utc = dt_msk - timedelta(hours=3)
    lst = lst_hours(dt_utc, MOSCOW_LON)
    result = []
    for name, ra, dec, mag, con in STARS:
        alt, az = altaz(ra, dec, lst, MOSCOW_LAT)
        result.append((name, alt, az, mag, con))
    return result

if __name__ == "__main__":
    from datetime import date
    for h in [0,5,10,15,20]:
        dt = datetime(2026,8,4,h,0,0)
        sun_alt = sun_altitude_moscow(dt)
        visible = [s for s in stars_moscow(dt) if s[1] > 0]
        print(f"{h:02d}:00 MSK -> sun_alt={sun_alt:.1f} deg, stars above horizon={len(visible)}")
