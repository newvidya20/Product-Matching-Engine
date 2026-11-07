"""Stage 2: rasterize a single page and clean it for OCR. One page in memory at a time."""
from __future__ import annotations

import cv2
import numpy as np
import pymupdf as fitz


def render_page(page: "fitz.Page", dpi: int) -> np.ndarray:
    """Rasterize to a BGR array. alpha off, so transparent regions come out white, not black."""
    pix = page.get_pixmap(dpi=dpi, alpha=False, colorspace=fitz.csRGB)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    return cv2.cvtColor(img, cv2.COLOR_RGB2BGR)


def load_image_file(path: str, max_side: int = 6000) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("unreadable image")
    h, w = img.shape[:2]
    if max(h, w) > max_side:
        s = max_side / max(h, w)
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return img


def rotate_bound(img: np.ndarray, angle: float, border=255) -> np.ndarray:
    """Rotate about the centre, growing the canvas so nothing is cropped."""
    h, w = img.shape[:2]
    if angle % 360 == 0:
        return img
    if angle % 90 == 0:
        k = int(angle // 90) % 4  # clockwise quarter turns -> np.rot90 is counter-clockwise
        return np.ascontiguousarray(np.rot90(img, -k))
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    c, s = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * s + w * c), int(h * c + w * s)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, m, (nw, nh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=(border,) * 3)


def detect_orientation(gray: np.ndarray, tess_cmd: str | None, tessdata: str) -> int:
    """Multiples of 90 to rotate clockwise so text is upright (Tesseract OSD). 0 when unsure."""
    if not tess_cmd:
        return 0
    try:
        import pytesseract
        pytesseract.pytesseract.tesseract_cmd = tess_cmd
        small = gray
        if max(gray.shape) > 1600:
            s = 1600 / max(gray.shape)
            small = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        osd = pytesseract.image_to_osd(small, config='--psm 0', output_type=pytesseract.Output.DICT, timeout=30)
        if float(osd.get("orientation_conf", 0)) >= 2.0:
            return int(osd.get("rotate", 0)) % 360
    except Exception:
        pass
    return 0


def best_rotation_by_reading(gray: np.ndarray, tess_cmd: str | None, osd_guess: int = 0) -> int:
    """Tesseract OSD fails on dense tables and rotated landscape pages. Read a downscaled copy at 0/90/180/270 and keep
    the rotation with the most confidently-read letters. The OSD guess wins unless another rotation is clearly better."""
    if not tess_cmd:
        return osd_guess
    import pytesseract
    pytesseract.pytesseract.tesseract_cmd = tess_cmd
    small = gray
    if max(gray.shape) > 1500:
        s = 1500 / max(gray.shape)
        small = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    scores = {}
    for rot in (0, 90, 180, 270):
        img = rotate_bound(small, rot)
        try:
            d = pytesseract.image_to_data(img, lang="eng", config="--oem 1 --psm 6", output_type=pytesseract.Output.DICT, timeout=60)
            scores[rot] = sum(float(c) * min(len(t), 8) for t, c in zip(d["text"], d["conf"]) if t.strip().isalpha() and len(t) >= 3 and float(c) > 60)
        except Exception:
            scores[rot] = 0.0
    best = max(scores, key=scores.get)
    if best != osd_guess and scores[best] > 1.5 * scores.get(osd_guess, 0.0) + 200:
        return best
    return osd_guess


def estimate_skew(gray: np.ndarray) -> float:
    """Skew angle in degrees (small angles only, +/-15), from the minimum-area box of the ink pixels."""
    small = gray
    if max(gray.shape) > 1400:
        s = 1400 / max(gray.shape)
        small = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    bw = cv2.threshold(cv2.GaussianBlur(small, (3, 3), 0), 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    # join characters into lines so the box follows text direction rather than single glyphs
    bw = cv2.dilate(bw, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3)))
    lines = cv2.HoughLinesP(bw, 1, np.pi / 720, threshold=200, minLineLength=small.shape[1] // 4, maxLineGap=20)
    if lines is None:
        return 0.0
    angles = []
    for x1, y1, x2, y2 in lines[:, 0]:
        a = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(a) <= 15:
            angles.append(a)
    return float(np.median(angles)) if len(angles) >= 5 else 0.0


def remove_background(gray: np.ndarray) -> np.ndarray:
    """Flatten uneven lighting and scanner shadows by dividing by a heavily blurred background estimate."""
    k = max(31, (min(gray.shape) // 20) | 1)
    bg = cv2.medianBlur(cv2.dilate(gray, np.ones((7, 7), np.uint8)), k if k % 2 else k + 1)
    return cv2.divide(gray, bg, scale=255)


def crop_dark_border(img: np.ndarray, gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Trim black scanner borders when the outer frame is mostly dark. Never crops more than 8% per side."""
    h, w = gray.shape
    m = max(4, int(min(h, w) * 0.08))
    edges = [gray[:m, :], gray[-m:, :], gray[:, :m], gray[:, -m:]]
    if sum(float(e.mean()) < 70 for e in edges) < 2:
        return img, gray
    mask = gray > 110
    ys, xs = np.where(mask)
    if len(ys) == 0:
        return img, gray
    y0, y1, x0, x1 = max(0, ys.min()), min(h, ys.max() + 1), max(0, xs.min()), min(w, xs.max() + 1)
    y0, x0 = min(y0, m), min(x0, m)
    y1, x1 = max(y1, h - m), max(x1, w - m)
    return img[y0:y1, x0:x1], gray[y0:y1, x0:x1]


def preprocess(bgr: np.ndarray, tess_cmd: str | None = None, tessdata: str = "", denoise: bool = True, robust: bool = False) -> dict:
    """Return {'original','clean','binary','rotation','skew'}. `original` is kept for fallback / vision.
    robust=True also cross-checks the orientation by reading at all four rotations (max profile)."""
    original = bgr
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    original, gray = crop_dark_border(original, gray)

    rot = detect_orientation(gray, tess_cmd, tessdata)
    if robust:
        rot = best_rotation_by_reading(gray, tess_cmd, rot)
    if rot:
        original = rotate_bound(original, rot)
        gray = cv2.cvtColor(original, cv2.COLOR_BGR2GRAY)

    skew = estimate_skew(gray)
    if 0.2 <= abs(skew) <= 15:
        original = rotate_bound(original, skew)
        gray = cv2.cvtColor(original, cv2.COLOR_BGR2GRAY)
    else:
        skew = 0.0

    flat = remove_background(gray)
    if denoise:
        flat = cv2.fastNlMeansDenoising(flat, None, h=6, templateWindowSize=5, searchWindowSize=15)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    clean = clahe.apply(flat)
    binary = cv2.adaptiveThreshold(clean, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 41, 15)
    return {"original": original, "clean": clean, "binary": binary, "rotation": rot, "skew": round(skew, 2)}
