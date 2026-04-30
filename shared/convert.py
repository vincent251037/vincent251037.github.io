import os
import re
import json
import math
import ssl
import sys
import urllib.request
import urllib.error
from xml.etree import ElementTree as ET
from datetime import datetime, timezone

# macOS Python lacks bundled SSL certs; use unverified context for public APIs
_SSL_CTX = ssl._create_unverified_context()

NS = {"gpx": "http://www.topografix.com/GPX/1/1"}

WMO_ICONS = {
    0: ("☀️", "晴"),
    1: ("🌤️", "少雲"), 2: ("⛅", "多雲"), 3: ("☁️", "陰"),
    45: ("🌫️", "霧"), 48: ("🌫️", "霧"),
    51: ("🌦️", "毛毛雨"), 53: ("🌦️", "毛毛雨"), 55: ("🌧️", "細雨"),
    61: ("🌧️", "小雨"), 63: ("🌧️", "中雨"), 65: ("🌧️", "大雨"),
    71: ("❄️", "小雪"), 73: ("❄️", "中雪"), 75: ("❄️", "大雪"),
    80: ("🌦️", "陣雨"), 81: ("🌧️", "陣雨"), 82: ("⛈️", "強陣雨"),
    95: ("⛈️", "雷雨"), 96: ("⛈️", "雷雨"), 99: ("⛈️", "雷雨"),
}


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def parse_time(s):
    if s is None:
        return None
    s = s.rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def detect_area(points):
    if not points:
        return "other", "其他"
    avg_lat = sum(p["lat"] for p in points) / len(points)
    avg_lon = sum(p["lon"] for p in points) / len(points)
    max_lat = max(p["lat"] for p in points)

    if avg_lon > 121.72:
        return "jilong", "基隆"
    elif max_lat > 25.22:
        return "jinshan", "金山"
    elif avg_lat > 25.08 and avg_lon < 121.52:
        return "tamsui", "淡水"
    elif avg_lat < 25.08:
        return "luzhou", "蘆洲"
    else:
        return "other", "其他"


def fetch_weather(lat, lon, start_time):
    if start_time is None:
        return None
    date_str = start_time.strftime("%Y-%m-%d")
    local_hour = (start_time.hour + 8) % 24
    target_hour = max(local_hour, 6)

    url = (
        "https://archive-api.open-meteo.com/v1/archive"
        f"?latitude={lat:.3f}&longitude={lon:.3f}"
        f"&start_date={date_str}&end_date={date_str}"
        "&hourly=temperature_2m,weathercode"
        "&timezone=Asia%2FTaipei"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=12, context=_SSL_CTX) as resp:
            data = json.loads(resp.read())
        times = data["hourly"]["time"]
        temps = data["hourly"]["temperature_2m"]
        codes = data["hourly"]["weathercode"]
        idx = next(
            (i for i, t in enumerate(times) if t.endswith(f"T{target_hour:02d}:00")),
            len(times) // 2,
        )
        temp = round(temps[idx], 1) if temps[idx] is not None else None
        code = int(codes[idx]) if codes[idx] is not None else 0
        icon, desc = WMO_ICONS.get(code, ("🌤️", "晴"))
        return {"temp": temp, "code": code, "icon": icon, "desc": desc}
    except Exception as e:
        print(f"    天氣擷取失敗: {e}")
        return None


def read_gpx_name(filepath):
    """Read the <trk><name> field from a GPX file."""
    try:
        tree = ET.parse(filepath)
        root = tree.getroot()
        el = root.find("gpx:trk/gpx:name", NS)
        if el is not None and el.text:
            return el.text.strip()
    except Exception:
        pass
    return None


def read_gpx_calories(filepath):
    """Read calories from <trk><desc>總消耗卡路里NNNN...</desc>."""
    try:
        tree = ET.parse(filepath)
        root = tree.getroot()
        el = root.find("gpx:trk/gpx:desc", NS)
        if el is not None and el.text:
            m = re.search(r'總消耗卡路里(\d+)', el.text)
            if m:
                return int(m.group(1))
    except Exception:
        pass
    return None


def process_gpx(filepath):
    tree = ET.parse(filepath)
    root = tree.getroot()
    trkpts = root.findall(".//gpx:trkpt", NS)

    points = []
    for pt in trkpts:
        lat = float(pt.attrib["lat"])
        lon = float(pt.attrib["lon"])
        ele_el = pt.find("gpx:ele", NS)
        time_el = pt.find("gpx:time", NS)
        ele = float(ele_el.text) if ele_el is not None else 0.0
        t = parse_time(time_el.text if time_el is not None else None)
        points.append({"lat": lat, "lon": lon, "ele": ele, "time": t})

    if not points:
        return None

    total_distance = 0.0
    total_ascent = 0.0
    total_descent = 0.0
    max_elevation = points[0]["ele"]
    speeds = []
    output_points = []

    for i, pt in enumerate(points):
        speed = 0.0
        if i > 0:
            prev = points[i - 1]
            dist = haversine(prev["lat"], prev["lon"], pt["lat"], pt["lon"])
            total_distance += dist
            elev_diff = pt["ele"] - prev["ele"]
            if elev_diff > 0:
                total_ascent += elev_diff
            else:
                total_descent += abs(elev_diff)
            if pt["time"] and prev["time"]:
                dt = (pt["time"] - prev["time"]).total_seconds()
                if dt > 0:
                    speed = (dist / dt) * 3.6
        if pt["ele"] > max_elevation:
            max_elevation = pt["ele"]
        speeds.append(speed)
        output_points.append({
            "lat": round(pt["lat"], 5),
            "lon": round(pt["lon"], 5),
            "ele": round(pt["ele"], 1),
            "time": pt["time"].isoformat() if pt["time"] else None,
            "speed": round(speed, 2),
        })

    moving_speeds = [s for s in speeds if s > 1.0]
    avg_speed = sum(moving_speeds) / len(moving_speeds) if moving_speeds else 0.0

    start_time = points[0]["time"]
    end_time = points[-1]["time"]
    duration_sec = (end_time - start_time).total_seconds() if start_time and end_time else 0

    area_key, area_label = detect_area(points)

    mid = points[len(points) // 2]
    print(f"  擷取天氣資料…")
    weather = fetch_weather(mid["lat"], mid["lon"], start_time)

    stats = {
        "total_distance_km": round(total_distance / 1000, 3),
        "total_ascent_m": round(total_ascent, 1),
        "total_descent_m": round(total_descent, 1),
        "max_elevation_m": round(max_elevation, 1),
        "avg_speed_kmh": round(avg_speed, 2),
        "duration_sec": int(duration_sec),
        "start_time": start_time.isoformat() if start_time else None,
        "end_time": end_time.isoformat() if end_time else None,
        "point_count": len(output_points),
        "area": area_key,
        "area_label": area_label,
        "weather": weather,
    }

    return {"stats": stats, "points": output_points}


def load_names(gpx_dir):
    names_path = os.path.join(gpx_dir, "names.json")
    if os.path.exists(names_path):
        with open(names_path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def main(gpx_dir):
    data_dir = os.path.join(gpx_dir, "data")
    os.makedirs(data_dir, exist_ok=True)

    names = load_names(gpx_dir)
    gpx_files = sorted(f for f in os.listdir(gpx_dir) if f.endswith(".gpx"))
    index = []

    for filename in gpx_files:
        stem = os.path.splitext(filename)[0]
        filepath = os.path.join(gpx_dir, filename)
        out_path = os.path.join(data_dir, f"{stem}.json")

        # Name priority: names.json (manual) > GPX <trk><name>
        gpx_name = read_gpx_name(filepath)
        gpx_calories = read_gpx_calories(filepath)
        name = names.get(stem) or gpx_name

        if os.path.exists(out_path):
            with open(out_path, encoding="utf-8") as f:
                result = json.load(f)
            entry = {
                "file": f"{stem}.json",
                "source": filename,
                **{k: result["stats"][k] for k in result["stats"]},
            }
            if name:
                entry["name"] = name
            if gpx_calories is not None:
                entry["calories"] = gpx_calories
            index.append(entry)
            continue

        print(f"Processing {filename}...")
        result = process_gpx(filepath)
        if result is None:
            print(f"  No track points found, skipping.")
            continue

        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

        entry = {
            "file": f"{stem}.json",
            "source": filename,
            **{k: result["stats"][k] for k in result["stats"]},
        }
        if name:
            entry["name"] = name
        if gpx_calories is not None:
            entry["calories"] = gpx_calories
        index.append(entry)
        print(f"  → {out_path}")

    # Sort newest first
    index.sort(key=lambda x: x.get("start_time") or "", reverse=True)

    index_path = os.path.join(data_dir, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"\nIndex written to {index_path} ({len(index)} activities)")


if __name__ == "__main__":
    gpx_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    main(os.path.abspath(gpx_dir))
