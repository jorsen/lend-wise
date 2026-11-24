"""
LendWise local OCR service — runs only on this PC.

  POST /ocr   body = image bytes (JPEG/PNG)  ->  JSON table of members

Engine: RapidOCR (PaddleOCR PP-OCRv4 models on ONNX Runtime; the model files ship
inside the pip package, so nothing is downloaded at runtime).

Table logic:
  * Every text box is read (printed CIDs/names and handwritten amounts).
  * The sheet's printed horizontal ruling lines are traced across the page with
    OpenCV. Each text box is assigned to the band between two ruling lines. This
    keeps handwriting on the right row even when the photo is tilted, the page is
    curled near the binding, or the writing drifts above/below the line.
  * Columns come from the printed headers (CID / MEMBER'S NAME / AMOUNT PAID/CASH /
    CLIENT INITIATED / AGENT ASSISTED / REFERENCE NUMBER).
  * The vertical column lines are traced the same way, so each box lands in the
    right column even when the page is rotated or curled.

Start:  ocr-server\\.venv\\Scripts\\python ocr-server\\server.py   (or: npm run ocr)
"""

from __future__ import annotations

import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

HOST = "127.0.0.1"
PORT = 8765
MAX_SIDE = 2600  # resize large phone photos to this long side before OCR

engine = RapidOCR()
engine_lock = Lock()  # onnxruntime sessions are shared; keep one OCR at a time

AMOUNT_FIELDS = ("amountPaid", "clientInitiated", "agentAssisted")


# --------------------------------------------------------------------------- #
# Text helpers
# --------------------------------------------------------------------------- #

def digits_only(text: str) -> str:
    return re.sub(r"\D", "", text)


def extract_cid(text: str) -> str | None:
    t = text.replace("O", "0").replace("o", "0").replace("l", "1").replace("I", "1")
    runs = sorted(re.findall(r"\d+", t), key=len, reverse=True)
    if not runs:
        return None
    best = runs[0]
    if 6 <= len(best) <= 10:
        return best
    if 11 <= len(best) <= 12:  # row number glued in front
        return best[-10:]
    return None


AMOUNT_MAP = str.maketrans({
    "O": "0", "o": "0", "D": "0", "Q": "0", "U": "0", "u": "0", "°": "0",
    "l": "1", "I": "1", "|": "1", "i": "1", "!": "1", "]": "1", "[": "1", "(": "1", ")": "1",
    "S": "5", "s": "5", "$": "5",
    "Z": "2", "z": "2",
    "B": "8",
    "g": "9", "q": "9",
    "G": "6", "b": "6",
    "A": "4",
    "T": "7",
})


def parse_amount(text: str) -> int | None:
    """Handwritten amount -> number. Dashes mean 'no payment'. None = unreadable."""
    t = text.strip().replace(" ", "")
    if not t:
        return None
    if re.fullmatch(r"[-–—_~=.]+", t):
        return 0
    t = t.translate(AMOUNT_MAP)
    t = re.sub(r"[.,'`](?=\d{3}\b)", "", t)  # 1,500 / 1.500
    t = t.strip(".,'`:;\"")
    t = re.sub(r"\.0+$", "", t)  # 2.00 -> 2 ... handled below
    if not re.fullmatch(r"\d{1,6}", t):
        return None
    if len(t) > 1 and t.startswith("0"):
        return None  # e.g. "Q0l" -> "001": a misread, let the user check it
    return int(t)


def fix_amount_scale(n: int, raw: str) -> int:
    # "2.00" written as 200 with a stray dot
    if re.fullmatch(r"\d\.\d\d", raw.strip()):
        return int(raw.replace(".", ""))
    return n


def fix_name(name: str) -> str:
    """Restore spaces the recogniser drops: 'BENILDAV.MARQUEZ' -> 'BENILDA V. MARQUEZ'."""
    s = name.upper()
    s = re.sub(r"[^A-ZÑ .,'-]", "", s)
    s = re.sub(r"\.(?=[A-ZÑ])", ". ", s)           # V.MARQUEZ -> V. MARQUEZ
    s = re.sub(r"\b([A-ZÑ]{3,})([A-Z])\.", r"\1 \2.", s)  # BENILDAV. -> BENILDA V.
    s = re.sub(r"\s+", " ", s).strip(" .,-")
    return s


# --------------------------------------------------------------------------- #
# Ruling-line tracking
# --------------------------------------------------------------------------- #

def detect_line_tracks(gray: np.ndarray, x_lo: int, x_hi: int, ref_x: int):
    """
    Traces the printed horizontal ruling lines between x_lo..x_hi.
    Returns (strip_centers, tracks) where tracks[k][j] is the y of line k at strip j,
    or None when lines could not be found.
    """
    h, w = gray.shape
    bw = cv2.adaptiveThreshold(~gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 15, -2)
    bw = cv2.dilate(bw, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 2)))
    k = max(15, w // 45)
    horiz = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1)))

    strip_w = max(12, w // 60)
    x_lo = max(0, x_lo)
    x_hi = min(w, x_hi)
    centers = list(range(x_lo + strip_w // 2, x_hi - strip_w // 2, strip_w))
    if len(centers) < 3:
        return None

    def peaks(xc: int) -> list[float]:
        a = max(0, xc - strip_w // 2)
        col = horiz[:, a:a + strip_w].sum(axis=1) / 255.0
        on = col > strip_w * 0.45
        ys, start = [], None
        for y, v in enumerate(on):
            if v and start is None:
                start = y
            elif not v and start is not None:
                ys.append((start + y - 1) / 2)
                start = None
        if start is not None:
            ys.append((start + h - 1) / 2)
        return ys

    strip_peaks = [peaks(c) for c in centers]
    ref_j = min(range(len(centers)), key=lambda j: abs(centers[j] - ref_x))
    ref = strip_peaks[ref_j]
    if len(ref) < 5:
        return None
    gaps = np.diff(ref)
    gaps = gaps[gaps > 4]
    if len(gaps) == 0:
        return None
    row_gap = float(np.median(gaps))
    tol = row_gap * 0.35

    tracks = []
    for y0 in ref:
        tr = [None] * len(centers)
        tr[ref_j] = y0
        for direction in (1, -1):
            prev_y, slope = y0, 0.0
            j = ref_j + direction
            misses = 0
            while 0 <= j < len(centers):
                pred = prev_y + slope
                cand = [p for p in strip_peaks[j] if abs(p - pred) < tol]
                if cand:
                    y = min(cand, key=lambda p: abs(p - pred))
                    slope = 0.7 * slope + 0.3 * (y - prev_y)
                    misses = 0
                else:
                    y = pred  # covered by writing / faint: carry on along the trend
                    misses += 1
                tr[j] = y
                prev_y = y
                j += direction
        tracks.append(tr)

    # Smooth each track (median of neighbours) to remove jumps onto neighbouring lines
    arr = np.array(tracks, dtype=float)
    for r in range(arr.shape[0]):
        row = arr[r]
        sm = row.copy()
        for j in range(len(row)):
            a, b = max(0, j - 2), min(len(row), j + 3)
            sm[j] = np.median(row[a:b])
        arr[r] = sm
    # Keep tracks in order (no crossings)
    arr.sort(axis=0)
    return np.array(centers, dtype=float), arr, row_gap


def band_of(x: float, y: float, line_model) -> float:
    """Index of the band (between ruling lines) containing (x, y); fractional part = position in band."""
    centers, tracks, _ = line_model
    ys = np.array([np.interp(x, centers, tr) for tr in tracks])
    idx = int(np.searchsorted(ys, y))
    if idx == 0 or idx >= len(ys):
        return float(idx)
    top, bot = ys[idx - 1], ys[idx]
    return idx - 1 + (y - top) / max(1.0, bot - top)


# --------------------------------------------------------------------------- #
# Main table extraction
# --------------------------------------------------------------------------- #

def box_info(box, text, score):
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    return {
        "text": str(text).strip(),
        "conf": float(score),
        "x0": float(min(xs)), "x1": float(max(xs)),
        "y0": float(min(ys)), "y1": float(max(ys)),
        "xc": float(sum(xs) / 4), "yc": float(sum(ys) / 4),
    }


HEADER_PATTERNS = {
    "cid": re.compile(r"^C\.?I\.?D\.?$", re.I),
    "name": re.compile(r"MEMBER|NAME", re.I),
    "amountPaid": re.compile(r"AMOU|PAID|CASH", re.I),
    "clientInitiated": re.compile(r"CLIEN|CLENT|INITI|INTIA|TIATED", re.I),
    "agentAssisted": re.compile(r"AGEN|AGEH|ASSIS|SSIST", re.I),
    "reference": re.compile(r"REFER|ERENCE", re.I),
}


def extract(img: np.ndarray) -> dict:
    h, w = img.shape[:2]
    scale = min(1.0, MAX_SIDE / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    t0 = time.time()
    with engine_lock:
        # slightly lower thresholds than the defaults pick up more faint handwriting
        res, _ = engine(img, box_thresh=0.3, text_score=0.3)
    words = [box_info(b, t, s) for b, t, s in (res or []) if str(t).strip()]

    # --- CIDs ---------------------------------------------------------------
    anchors = []
    for wd in words:
        cid = extract_cid(wd["text"])
        if cid and "," not in wd["text"] and wd["x1"] - wd["x0"] > 2 * (wd["y1"] - wd["y0"]):
            anchors.append((cid, wd))
    if not anchors:
        return {"rows": [], "columnsDetected": False, "words": words, "seconds": time.time() - t0,
                "error": "No CIDs found on the image."}
    cid_x = float(np.median([a[1]["xc"] for a in anchors]))
    spread = float(np.median([abs(a[1]["xc"] - cid_x) for a in anchors])) * 4 + w * 0.05
    anchors = [a for a in anchors if abs(a[1]["xc"] - cid_x) < spread]
    anchors.sort(key=lambda a: a[1]["yc"])
    first_y = anchors[0][1]["yc"]
    cid_right = float(np.median([a[1]["x1"] for a in anchors]))
    char_h = float(np.median([a[1]["y1"] - a[1]["y0"] for a in anchors]))

    # The page is rarely square to the camera: lower rows usually sit further left/right.
    # Model the CID column's right edge as x = f(y) (robust line fit) and shift every
    # column boundary by the same amount at each height.
    ay = np.array([a[1]["yc"] for a in anchors])
    ax = np.array([a[1]["x1"] for a in anchors])
    if len(anchors) >= 4:
        coef = np.polyfit(ay, ax, 1)
        resid = np.abs(ax - np.polyval(coef, ay))
        keep = resid < max(char_h, np.median(resid) * 3)
        if keep.sum() >= 3:
            coef = np.polyfit(ay[keep], ax[keep], 1)
    else:
        coef = np.array([0.0, cid_right])

    def shift_at(y: float) -> float:
        """How far the table is shifted at height y relative to the header row."""
        return float(np.polyval(coef, y) - np.polyval(coef, first_y))

    cid_right = float(np.polyval(coef, first_y))  # CID column edge at the header row

    # --- column headers (above the first row) -------------------------------
    header_words = [wd for wd in words if first_y - char_h * 10 < wd["yc"] < first_y - char_h * 0.5]
    col_x: dict[str, float] = {}
    for key, pat in HEADER_PATTERNS.items():
        hits = [wd["xc"] - shift_at(wd["yc"]) for wd in header_words if pat.search(wd["text"])]
        if hits:
            col_x[key] = float(np.median(hits))
    # enforce left-to-right order of the amount headers
    last = cid_right
    for key in ("amountPaid", "clientInitiated", "agentAssisted", "reference"):
        if key in col_x:
            if col_x[key] <= last:
                del col_x[key]
            else:
                last = col_x[key]
    amount_cols = [k for k in AMOUNT_FIELDS if k in col_x]
    known = amount_cols + (["reference"] if "reference" in col_x else [])
    if len(known) >= 2:
        col_w = float(min(np.diff([col_x[k] for k in known])))
    else:
        col_w = char_h * 6
    # Infer missing amount columns from the ones found (the sheet's three amount columns are adjacent)
    if "agentAssisted" in col_x:
        col_x.setdefault("clientInitiated", col_x["agentAssisted"] - col_w)
        col_x.setdefault("amountPaid", col_x["agentAssisted"] - 2 * col_w)
        amount_cols = list(AMOUNT_FIELDS)
    columns_detected = bool(amount_cols)
    name_end = (min(col_x[k] for k in amount_cols) - col_w * 0.55) if amount_cols else cid_right + (w - cid_right) * 0.45
    table_right = (col_x["reference"] + col_w) if "reference" in col_x else (
        max(col_x[k] for k in amount_cols) + col_w * 0.8 if amount_cols else w)

    # --- ruling lines --------------------------------------------------------
    line_model = None
    try:
        line_model = detect_line_tracks(gray, int(anchors[0][1]["x0"] - char_h * 4), int(table_right), int(cid_x))
    except Exception as e:  # noqa: BLE001
        print("line detection failed:", e, file=sys.stderr)

    # --- vertical ruling lines -> exact column boundaries at every height ----
    # (same tracker on the transposed image). Columns then follow the page however it's
    # rotated or curled, and cell crops stay between the printed lines.
    col_model = None
    try:
        vm = detect_line_tracks(np.ascontiguousarray(gray.T), int(first_y - char_h * 12),
                                int(anchors[-1][1]["yc"] + char_h * 6), int(first_y))
        if vm is not None:
            v_centers, v_tracks, _ = vm

            def col_index(x: float, y: float) -> int:
                xs = np.array([np.interp(y, v_centers, tr) for tr in v_tracks])
                return int(np.searchsorted(xs, x))

            def col_bounds(idx: int, y: float):
                if idx <= 0 or idx >= len(v_tracks):
                    return None
                return (float(np.interp(y, v_centers, v_tracks[idx - 1])), float(np.interp(y, v_centers, v_tracks[idx])))

            def mode(vals):
                return max(set(vals), key=vals.count) if vals else None

            idx_of = {}
            for key, pat in HEADER_PATTERNS.items():
                hits = [col_index(wd["xc"], wd["yc"]) for wd in header_words if pat.search(wd["text"])]
                if hits:
                    idx_of[key] = mode(hits)
            cid_idx = mode([col_index(a[1]["xc"], a[1]["yc"]) for a in anchors])
            name_idx = idx_of.get("name")
            if name_idx is None or name_idx <= cid_idx:
                name_idx = cid_idx + 1
            # Amount columns: from headers when read, else the sheet layout (next 3 after the name)
            amt_idx = {}
            for off, key in enumerate(AMOUNT_FIELDS, start=1):
                i = idx_of.get(key)
                amt_idx[key] = i if (i is not None and i > name_idx) else name_idx + off
            if len(set(amt_idx.values())) == 3 and max(amt_idx.values()) < len(v_tracks):
                ref_idx = idx_of.get("reference")
                if ref_idx is None or ref_idx <= max(amt_idx.values()):
                    ref_idx = max(amt_idx.values()) + 1
                col_model = {"col_index": col_index, "col_bounds": col_bounds, "cid": cid_idx,
                             "name": name_idx, "amounts": amt_idx, "reference": ref_idx}
    except Exception as e:  # noqa: BLE001
        print("column detection failed:", e, file=sys.stderr)
    if col_model is not None:
        columns_detected = True
        amount_cols = list(AMOUNT_FIELDS)

    if line_model is not None:
        def row_key(x, y):
            return int(np.floor(band_of(x, y, line_model)))
    else:
        # Fallback: nearest CID row with straight geometry
        row_ys = [a[1]["yc"] for a in anchors]
        gap = float(np.median(np.diff(row_ys))) if len(row_ys) > 1 else char_h * 2

        def row_key(x, y):
            return int(round((y - row_ys[0]) / gap)) + 10000

    # --- build rows keyed by band -------------------------------------------
    rows: dict[int, dict] = {}
    for cid, wd in anchors:
        k = row_key(wd["xc"], wd["yc"])
        cur = rows.get(k)
        score = (100 if len(cid) in (6, 10) else 0) + wd["conf"]
        if cur is None or score > cur["_score"]:
            rows[k] = {"_score": score, "_y": wd["yc"], "_x": wd["xc"], "_x1": wd["x1"], "cid": cid, "cidConf": wd["conf"],
                       "nameParts": [], "cells": {}}

    anchor_ids = {id(a[1]) for a in anchors}
    min_k, max_k = min(rows), max(rows)
    header_re = re.compile(r"MEMBER|NAME|TOTAL|AMOUNT|^NO$|^CID$", re.I)
    cols_all = amount_cols + (["reference"] if "reference" in col_x else [])
    for wd in words:
        if id(wd) in anchor_ids:
            continue
        k = row_key(wd["xc"], wd["yc"])
        if col_model is not None:
            ci = col_model["col_index"](wd["xc"], wd["yc"])
            if ci == col_model["name"] and re.search(r"[A-Za-z]{2,}", wd["text"]) and not header_re.search(wd["text"]):
                if k not in rows:
                    if not (min_k <= k <= max_k + 1):
                        continue
                    rows[k] = {"_score": 0, "_y": wd["yc"], "_x": cid_x, "_x1": cid_right, "cid": "", "cidConf": 0,
                               "nameParts": [], "cells": {}}
                rows[k]["nameParts"].append(wd)
            elif k in rows:
                for f, i in col_model["amounts"].items():
                    if ci == i:
                        rows[k]["cells"].setdefault(f, []).append(wd)
                if ci == col_model["reference"]:
                    rows[k]["cells"].setdefault("reference", []).append(wd)
            continue
        sh = shift_at(wd["yc"])
        cid_edge = rows[k]["_x1"] if k in rows else cid_right + sh
        # name column
        if (cid_edge - char_h * 0.5 < wd["x0"] and wd["xc"] < name_end + sh
                and re.search(r"[A-Za-z]{2,}", wd["text"]) and not header_re.search(wd["text"])):
            if k not in rows:
                if not (min_k <= k <= max_k + 1):
                    continue  # outside the member rows (header, footer, other page)
                rows[k] = {"_score": 0, "_y": wd["yc"], "_x": cid_x, "_x1": cid_right + sh, "cid": "", "cidConf": 0,
                           "nameParts": [], "cells": {}}
            rows[k]["nameParts"].append(wd)
            continue
        # amount / reference columns
        if amount_cols and name_end + sh <= wd["xc"] < table_right + sh and k in rows:
            field = min(cols_all, key=lambda c: abs(col_x[c] + sh - wd["xc"]))
            rows[k]["cells"].setdefault(field, []).append(wd)

    # A row split in two (CID in one band, name in the next) -> merge
    for k in sorted(rows):
        r = rows.get(k)
        if r is None:
            continue
        for nb in (k - 1, k + 1):
            o = rows.get(nb)
            if o is None:
                continue
            if r["cid"] and not r["nameParts"] and not o["cid"] and o["nameParts"]:
                r["nameParts"] = o["nameParts"]
                for f, c in o["cells"].items():
                    r["cells"].setdefault(f, []).extend(c)
                del rows[nb]
                break

    # --- output --------------------------------------------------------------
    out_rows = []
    for k in sorted(rows):
        r = rows[k]
        parts = sorted(r["nameParts"], key=lambda p: p["x0"])
        name = fix_name(" ".join(p["text"] for p in parts))
        confs = [r["cidConf"]] + [p["conf"] for p in parts]
        notes = []
        row = {"cid": r["cid"], "name": name, "amountPaid": "", "clientInitiated": "", "agentAssisted": "",
               "referenceNumber": ""}
        for field, cell in r["cells"].items():
            cell = sorted(cell, key=lambda p: p["x0"])
            raw = "".join(p["text"] for p in cell)
            confs += [p["conf"] for p in cell]
            if field == "reference":
                row["referenceNumber"] = raw
                continue
            if len(re.sub(r"[^0-9A-Za-z]", "", raw)) < 2 and not re.fullmatch(r"[-–—_~=]+", raw):
                continue  # lone stroke = table line
            n = parse_amount(raw)
            if n is None:
                notes.append(f'Unreadable amount "{raw}"')
                row[field] = raw
            elif n == 0:
                row[field] = ""  # dash = no payment
            else:
                row[field] = str(fix_amount_scale(n, raw))
        if not r["cid"]:
            notes.append("CID not read")
        elif len(r["cid"]) not in (6, 10):
            notes.append("Unusual CID length")
        if not name:
            notes.append("Name not read")
        if not r["cid"] and not name:
            continue
        row["confidence"] = round(min(confs) * 100)
        row["notes"] = notes
        out_rows.append(row)

    return {
        "rows": out_rows,
        "columnsDetected": columns_detected,
        "lines": None if line_model is None else len(line_model[1]),
        "columns": None if col_model is None else {k: col_model[k] for k in ("cid", "name", "amounts", "reference")},
        "seconds": round(time.time() - t0, 2),
        "text": "\n".join(wd["text"] for wd in sorted(words, key=lambda d: (round(d["yc"] / max(char_h, 1)), d["x0"]))),
    }


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self._send(204, {})

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("", "/health", "/api/ocr/health"):
            self._send(200, {"ok": True, "engine": "rapidocr"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") not in ("/ocr", "/api/ocr"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0 or n > 40 * 1024 * 1024:
                return self._send(400, {"error": "Send an image under 40 MB"})
            data = np.frombuffer(self.rfile.read(n), dtype=np.uint8)
            img = cv2.imdecode(data, cv2.IMREAD_COLOR)
            if img is None:
                return self._send(400, {"error": "Could not decode image"})
            self._send(200, extract(img))
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._send(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        sys.stderr.write("[ocr] " + (fmt % args) + "\n")


def main():
    if len(sys.argv) > 1 and sys.argv[1] != "--serve":
        # CLI test: python server.py image.jpg
        img = cv2.imread(sys.argv[1])
        print(json.dumps(extract(img), indent=1, ensure_ascii=False))
        return
    # On Windows SO_REUSEADDR would let a second copy bind the same port silently.
    ThreadingHTTPServer.allow_reuse_address = False
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        print(f"Port {PORT} is already in use - another OCR service is probably running.", file=sys.stderr)
        sys.exit(0)
    print(f"LendWise OCR service on http://{HOST}:{PORT}  (Ctrl+C to stop)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
