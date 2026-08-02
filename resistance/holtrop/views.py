# maneuver/holtrop/views.py
import base64
import gzip
import hashlib
import json
import math
import threading
from collections import OrderedDict

import numpy as np
from django.http import HttpResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt

from .engine import HoltropModel, _APPENDAGE_ORDER, _HULL_REQUIRED

try:
    import orjson
except Exception:
    orjson = None


MAX_BODY_BYTES = 64 * 1024
MAX_N_POINTS = 500
DEFAULT_N = 41
RESPONSE_CACHE_SIZE = 64

_RESPONSE_CACHE = OrderedDict()
_RESPONSE_CACHE_LOCK = threading.RLock()


def _json_dumps(obj):
    if orjson is not None:
        return orjson.dumps(obj)
    return json.dumps(
        obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def _cache_get_entry(key):
    with _RESPONSE_CACHE_LOCK:
        entry = _RESPONSE_CACHE.get(key)
        if entry is not None:
            _RESPONSE_CACHE.move_to_end(key)
        return entry


def _cache_set_raw(key, raw_bytes):
    with _RESPONSE_CACHE_LOCK:
        _RESPONSE_CACHE[key] = {"raw": raw_bytes, "gzip": None}
        _RESPONSE_CACHE.move_to_end(key)
        while len(_RESPONSE_CACHE) > RESPONSE_CACHE_SIZE:
            _RESPONSE_CACHE.popitem(last=False)
        return _RESPONSE_CACHE[key]


def _client_accepts_gzip(request):
    enc = request.META.get("HTTP_ACCEPT_ENCODING", "")
    return "gzip" in enc.lower()


def _response_from_entry(entry, request, status=200):
    raw = entry["raw"]
    use_gzip = _client_accepts_gzip(request) and len(raw) > 4096

    if use_gzip:
        gz = entry.get("gzip")
        if gz is None:
            gz = gzip.compress(raw, compresslevel=1)
            with _RESPONSE_CACHE_LOCK:
                entry["gzip"] = gz

        resp = HttpResponse(gz, status=status, content_type="application/json")
        resp["Content-Encoding"] = "gzip"
        resp["Vary"] = "Accept-Encoding"
        resp["Content-Length"] = str(len(gz))
    else:
        resp = HttpResponse(raw, status=status, content_type="application/json")
        resp["Content-Length"] = str(len(raw))

    resp["Cache-Control"] = "no-store, max-age=0"
    return resp


def _json_error(message, status=400, errors=None):
    payload = {"success": False, "message": message}
    if errors is not None:
        payload["errors"] = errors

    raw = _json_dumps(payload)
    resp = HttpResponse(raw, status=status, content_type="application/json")
    resp["Cache-Control"] = "no-store, max-age=0"
    resp["Content-Length"] = str(len(raw))
    return resp


def _as_float(data, key, default=None, required=False):
    if key not in data:
        if required:
            raise ValueError(f"Missing required field: {key}")
        return default

    value = data[key]
    if isinstance(value, bool):
        raise ValueError(f"Invalid numeric field: {key}")

    try:
        f = float(value)
    except Exception:
        raise ValueError(f"Invalid numeric field: {key}")

    if not math.isfinite(f):
        raise ValueError(f"Non-finite numeric field: {key}")

    return f


def _as_int(data, key, default=0, min_value=0, max_value=1_000_000):
    if key not in data:
        return default
    try:
        value = int(float(data[key]))
    except Exception:
        raise ValueError(f"Invalid integer field: {key}")
    if value < min_value:
        value = min_value
    elif value > max_value:
        value = max_value
    return value


def _parse_payload(data):
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object.")

    hull = {name: _as_float(data, name, required=True) for name in _HULL_REQUIRED}

    if hull["wl"] <= 0 or hull["beam"] <= 0:
        raise ValueError("wl and beam must be positive.")
    if hull["cm"] <= 0 or hull["cb"] <= 0:
        raise ValueError("cm and cb must be positive.")

    bulbous = _as_float(data, "bulbous", default=0.0)
    transom = _as_float(data, "transom", default=0.0)
    aft_body = _as_int(data, "aft_body", default=2, min_value=0, max_value=3)

    n_app = len(_APPENDAGE_ORDER)
    app_coefs = np.empty(n_app, dtype=np.float64)
    app_areas = np.empty(n_app, dtype=np.float64)
    for i, name in enumerate(_APPENDAGE_ORDER):
        app_coefs[i] = _as_float(data, name, default=0.0)
        app_areas[i] = _as_float(data, f"{name}_area", default=0.0)

    N = _as_int(data, "N", default=DEFAULT_N, min_value=2, max_value=MAX_N_POINTS)

    response_format = str(data.get("response_format", "json")).lower().strip()
    if response_format not in ("json", "compact"):
        response_format = "json"

    return {
        "hull": hull,
        "bulbous": bulbous,
        "transom": transom,
        "aft_body": aft_body,
        "app_coefs": app_coefs,
        "app_areas": app_areas,
        "N": N,
        "response_format": response_format,
    }


def _encode_f32_base64(arr):
    a = np.asarray(arr, dtype="<f4")
    return base64.b64encode(a.tobytes()).decode("ascii")


def _build_series_payload(
    response_format, speeds, fn, rf, rw, r_app, rb, rtr, r_total
):
    # Engine returns forces in Newtons; total already in kN.
    arrays = {
        "speeds": speeds,
        "froude_numbers": fn,
        "total_resistance": r_total,
        "friction_resistance": rf / 1000.0,
        "wave_resistance": rw / 1000.0,
        "appendage_resistance": r_app / 1000.0,
        "bulbous_bow_resistance": rb / 1000.0,
        "transom_stern_resistance": rtr / 1000.0,
    }

    n = int(speeds.shape[0])

    if response_format == "compact":
        payload = {"_format": "f32-base64-v1", "_length": n}
        for key, arr in arrays.items():
            payload[key] = _encode_f32_base64(arr)
    else:
        payload = {}
        for key, arr in arrays.items():
            selected = np.asarray(arr, dtype=np.float64)
            payload[key] = np.round(selected, 6).tolist()

    meta = {"sample_count": n}
    return payload, meta


@method_decorator(csrf_exempt, name="dispatch")
class HoltropResistanceView(View):
    """
    Optimized Holtrop & Mennen resistance calculation endpoint.

    POST /holtrop/

    Maintains response envelope:
    {
      "success": true,
      "data": {...},
      "message": "..."
    }
    """

    http_method_names = ["post", "options"]

    def options(self, request, *args, **kwargs):
        resp = HttpResponse(status=204)
        resp["Allow"] = "POST, OPTIONS"
        return resp

    def post(self, request, *args, **kwargs):
        raw_body = request.body or b"{}"

        if len(raw_body) > MAX_BODY_BYTES:
            return _json_error("Request body is too large.", status=413)

        cache_key = hashlib.blake2b(raw_body, digest_size=16).hexdigest()
        cached = _cache_get_entry(cache_key)
        if cached is not None:
            return _response_from_entry(cached, request, status=200)

        try:
            data = json.loads(raw_body)
        except Exception:
            return _json_error("Invalid JSON body.", status=400)

        try:
            parsed = _parse_payload(data)
        except ValueError as exc:
            return _json_error(str(exc), status=400)

        try:
            model = HoltropModel(
                **parsed["hull"],
                bulbous=parsed["bulbous"],
                transom=parsed["transom"],
                aft_body=parsed["aft_body"],
                app_coefs=parsed["app_coefs"],
                app_areas=parsed["app_areas"],
            )

            speeds, fn, rf, rw, r_app, rb, rtr, r_total = model.calculate(
                N=parsed["N"]
            )

            series_payload, series_meta = _build_series_payload(
                parsed["response_format"],
                speeds, fn, rf, rw, r_app, rb, rtr, r_total,
            )

            output_payload = {
                "success": True,
                "data": {
                    "series": series_payload,
                    "series_meta": series_meta,
                },
                "message": "Holtrop resistance calculations completed successfully.",
            }

            raw_response = _json_dumps(output_payload)
            entry = _cache_set_raw(cache_key, raw_response)
            return _response_from_entry(entry, request, status=200)

        except Exception as exc:
            return _json_error(
                message=f"Holtrop calculation fault: {str(exc)}",
                status=500,
            )