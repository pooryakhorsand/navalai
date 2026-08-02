# propeller/au/views.py
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

from .engine import AUSeriesModel, available_radii, RADIUS_STATIONS

try:
    import orjson
except Exception:
    orjson = None


MAX_BODY_BYTES = 32 * 1024
RESPONSE_CACHE_SIZE = 64

_RESPONSE_CACHE = OrderedDict()
_RESPONSE_CACHE_LOCK = threading.RLock()

_MODEL = AUSeriesModel()


def _json_dumps(obj):
    if orjson is not None:
        return orjson.dumps(obj)

    return json.dumps(
        obj,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False
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


def _as_float(data, key, default, min_value=None, max_value=None):
    if key not in data:
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

    if min_value is not None and f < min_value:
        f = min_value
    if max_value is not None and f > max_value:
        f = max_value

    return f


def _encode_f32_base64(arr):
    a = np.asarray(arr, dtype="<f4")
    return base64.b64encode(a.tobytes()).decode("ascii")


def _nearest_radius(rR):
    return min(RADIUS_STATIONS, key=lambda k: abs(k - rR))


def _parse_payload(data):
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object.")

    Z = _as_float(data, "Z", default=5.0, min_value=2.0, max_value=9.0)
    AE_AO = _as_float(data, "AE_AO", default=0.55, min_value=0.30, max_value=1.05)
    P_D = _as_float(data, "P_D", default=1.00, min_value=0.30, max_value=1.60)
    D = _as_float(data, "D", default=4.00, min_value=0.05, max_value=50.0)
    rR = _as_float(data, "rR", default=0.70, min_value=0.20, max_value=1.00)

    response_format = str(data.get("response_format", "json")).lower().strip()
    if response_format not in ("json", "compact"):
        response_format = "json"

    return {
        "Z": Z,
        "AE_AO": AE_AO,
        "P_D": P_D,
        "D": D,
        "rR": _nearest_radius(rR),
        "response_format": response_format,
    }


def _round_list(arr, decimals=6):
    return np.round(np.asarray(arr, dtype=np.float64), decimals).tolist()


@method_decorator(csrf_exempt, name="dispatch")
class AUSeriesSimulationView(View):
    """
    Optimized AU-series propeller solver endpoint.

    POST /au_series/

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
            perf = _MODEL.compute_performance(
                Z=parsed["Z"], AE_AO=parsed["AE_AO"], P_D=parsed["P_D"]
            )
            section = _MODEL.compute_section(rR=parsed["rR"], D=parsed["D"])

            if parsed["response_format"] == "compact":
                performance_payload = {
                    "_format": "f32-base64-v1",
                    "_length": int(perf["J_series"].shape[0]),
                    "J_series": _encode_f32_base64(perf["J_series"]),
                    "KT_series": _encode_f32_base64(perf["KT_series"]),
                    "KQ_series": _encode_f32_base64(perf["KQ_series"]),
                    "eta_series": _encode_f32_base64(perf["eta_series"]),
                }
                section_payload = {
                    "_format": "f32-base64-v1",
                    "_length": int(section["x_m"].shape[0]),
                    "x_m": _encode_f32_base64(section["x_m"]),
                    "y_back_m": _encode_f32_base64(section["y_back_m"]),
                    "y_face_m": _encode_f32_base64(section["y_face_m"]),
                    "thickness_m": _encode_f32_base64(section["thickness_m"]),
                }
            else:
                performance_payload = {
                    "J_series": _round_list(perf["J_series"], 4),
                    "KT_series": _round_list(perf["KT_series"], 6),
                    "KQ_series": _round_list(perf["KQ_series"], 6),
                    "eta_series": _round_list(perf["eta_series"], 6),
                }
                section_payload = {
                    "x_m": _round_list(section["x_m"], 6),
                    "y_back_m": _round_list(section["y_back_m"], 6),
                    "y_face_m": _round_list(section["y_face_m"], 6),
                    "thickness_m": _round_list(section["thickness_m"], 6),
                }

            output_payload = {
                "success": True,
                "data": {
                    "inputs": {
                        "Z": parsed["Z"],
                        "AE_AO": parsed["AE_AO"],
                        "P_D": parsed["P_D"],
                        "D": parsed["D"],
                        "rR": parsed["rR"],
                    },
                    "optimum": perf["optimum"],
                    "performance": performance_payload,
                    "section": {
                        "rR": section["rR"],
                        "r_m": round(section["r_m"], 6),
                        "chord_m": round(section["chord_m"], 6),
                        "tmax_m": round(section["tmax_m"], 6),
                        "max_thick_pos_pct": section["max_thick_pos_pct"],
                        **section_payload,
                    },
                    "available_radii": available_radii(),
                },
                "message": "AU-series calculation completed successfully.",
            }

            raw_response = _json_dumps(output_payload)
            entry = _cache_set_raw(cache_key, raw_response)

            return _response_from_entry(entry, request, status=200)

        except Exception as exc:
            return _json_error(
                message=f"AU-series calculation failed: {str(exc)}",
                status=500,
            )