"""Samples the composed DesktopChar HWND without writing screenshots to disk."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import statistics
import sys
import time


user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
RECT = wintypes.RECT
SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000
DIB_RGB_COLORS = 0
SAMPLE_WIDTH = 92
SAMPLE_HEIGHT = 140

try:
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except (AttributeError, OSError):
    user32.SetProcessDPIAware()

user32.GetDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.StretchBlt.argtypes = [
    wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.DWORD,
]
gdi32.GetDIBits.argtypes = [
    wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
    ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT,
]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def find_window(process_id: int, timeout_seconds: float = 5.0) -> int:
    deadline = time.perf_counter() + timeout_seconds
    while time.perf_counter() < deadline:
        hwnd = find_window_for_process(process_id)
        if hwnd:
            return hwnd
        time.sleep(0.02)
    raise RuntimeError("DesktopChar HWND was not found")


def find_window_for_process(process_id: int) -> int:
    matches: list[int] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def visit(hwnd: int, _lparam: int) -> bool:
        owner_process_id = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_process_id))
        if owner_process_id.value == process_id and user32.IsWindowVisible(hwnd):
            matches.append(hwnd)
            return False
        return True

    user32.EnumWindows(visit, 0)
    return matches[0] if matches else 0


def window_rect(hwnd: int) -> tuple[int, int, int, int]:
    rect = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise ctypes.WinError()
    return rect.left, rect.top, rect.right, rect.bottom


class ComposedScreenSampler:
    def __init__(self) -> None:
        self.screen_dc = user32.GetDC(0)
        self.memory_dc = gdi32.CreateCompatibleDC(self.screen_dc)
        self.bitmap = gdi32.CreateCompatibleBitmap(self.screen_dc, SAMPLE_WIDTH, SAMPLE_HEIGHT)
        self.previous_bitmap = gdi32.SelectObject(self.memory_dc, self.bitmap)
        self.buffer = (ctypes.c_ubyte * (SAMPLE_WIDTH * SAMPLE_HEIGHT * 4))()
        self.info = BITMAPINFO()
        self.info.bmiHeader = BITMAPINFOHEADER(
            ctypes.sizeof(BITMAPINFOHEADER), SAMPLE_WIDTH, -SAMPLE_HEIGHT,
            1, 32, 0, len(self.buffer), 0, 0, 0, 0,
        )

    def close(self) -> None:
        if self.previous_bitmap:
            gdi32.SelectObject(self.memory_dc, self.previous_bitmap)
        if self.bitmap:
            gdi32.DeleteObject(self.bitmap)
        if self.memory_dc:
            gdi32.DeleteDC(self.memory_dc)
        if self.screen_dc:
            user32.ReleaseDC(0, self.screen_dc)

    def sample(self, hwnd: int) -> dict[str, float | list[int]]:
        rect = window_rect(hwnd)
        width = rect[2] - rect[0]
        height = rect[3] - rect[1]
        copied = gdi32.StretchBlt(
            self.memory_dc, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT,
            self.screen_dc, rect[0], rect[1], width, height,
            SRCCOPY | CAPTUREBLT,
        )
        if not copied:
            raise ctypes.WinError()
        rows = gdi32.GetDIBits(
            self.memory_dc, self.bitmap, 0, SAMPLE_HEIGHT,
            self.buffer, ctypes.byref(self.info), DIB_RGB_COLORS,
        )
        if rows != SAMPLE_HEIGHT:
            raise ctypes.WinError()
        luminance = []
        chromatic = 0
        for index in range(0, len(self.buffer), 4):
            blue, green, red = self.buffer[index], self.buffer[index + 1], self.buffer[index + 2]
            maximum = max(red, green, blue)
            if maximum - min(red, green, blue) >= 32 and maximum >= 72:
                chromatic += 1
            luminance.append((red * 299 + green * 587 + blue * 114) / 1000)
        return image_metrics(rect, luminance, chromatic)


def image_metrics(rect: tuple[int, int, int, int], luminance: list[float], chromatic: int) -> dict[str, float | list[int]]:
    near_black = sum(value <= 12 for value in luminance)
    return {
        "rect": list(rect),
        "meanLuma": round(statistics.fmean(luminance), 3),
        "lumaDeviation": round(statistics.pstdev(luminance), 3),
        "chromaticRatio": round(chromatic / len(luminance), 6),
        "nearBlackRatio": round(near_black / len(luminance), 6),
    }


def main() -> None:
    duration_seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 1.4
    process_id = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    if process_id <= 0:
        raise ValueError("Electron process id is required")
    hwnd = find_window(process_id)
    start = time.perf_counter()
    frames = []
    sampler = ComposedScreenSampler()
    next_sample_at = start
    try:
        while time.perf_counter() - start < duration_seconds:
            now = time.perf_counter()
            if now < next_sample_at:
                time.sleep(next_sample_at - now)
            sampled_at = time.perf_counter()
            sample = sampler.sample(hwnd)
            sample["atMs"] = round((sampled_at - start) * 1000, 3)
            frames.append(sample)
            next_sample_at = max(next_sample_at + 0.004, sampled_at)
    finally:
        sampler.close()
    print(json.dumps({"hwnd": hwnd, "frames": frames}, separators=(",", ":")))


if __name__ == "__main__":
    main()
