import os
import json
import re
import struct
from datetime import datetime

PHOTO_DIR = os.path.dirname(os.path.abspath(__file__))
EXTS = {".jpg", ".jpeg", ".png", ".heic", ".webp"}


def get_exif_date(path):
    try:
        with open(path, "rb") as f:
            data = f.read()
        matches = re.findall(rb"(\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2})", data)
        if matches:
            raw = matches[0].decode()
            return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S")
    except Exception:
        pass
    return datetime.fromtimestamp(os.path.getmtime(path))


def get_image_size(path):
    try:
        with open(path, "rb") as f:
            data = f.read()
        i = 0
        while i < len(data) - 9:
            if data[i] == 0xFF and data[i + 1] in (0xC0, 0xC1, 0xC2):
                h = (data[i + 5] << 8) | data[i + 6]
                w = (data[i + 7] << 8) | data[i + 8]
                return w, h
            i += 1
    except Exception:
        pass
    return None, None


def size_class(width, height):
    if width is None or height is None:
        return "wide"
    ratio = width / height
    if ratio < 0.85:
        return "tall"
    elif ratio < 1.2:
        return "sq"
    return "wide"


def load_captions():
    path = os.path.join(PHOTO_DIR, "captions.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def main():
    captions = load_captions()
    images = [
        f for f in os.listdir(PHOTO_DIR)
        if os.path.splitext(f)[1].lower() in EXTS
    ]

    manifest = []
    for filename in images:
        path = os.path.join(PHOTO_DIR, filename)
        date = get_exif_date(path)
        meta = captions.get(filename, {})
        caption = meta.get("caption", "")
        if "size" in meta:
            sz = meta["size"]
        else:
            w, h = get_image_size(path)
            sz = size_class(w, h)
        manifest.append({
            "file": filename,
            "date": date.strftime("%Y-%m-%d"),
            "caption": caption,
            "size": sz,
        })

    manifest.sort(key=lambda x: x["date"], reverse=True)

    out = os.path.join(PHOTO_DIR, "manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"manifest.json 已更新（{len(manifest)} 張照片）")


if __name__ == "__main__":
    main()
