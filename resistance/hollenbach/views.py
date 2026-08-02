# resistance/hollenbach/views.py
import base64
import gzip
import hashlib
import json
import math
import threading
from collections import OrderedDict

import numpy as np
from django.http import HttpResponse
from django.shortcuts import render
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt

from .engine import (
    calculate_hollenbach_resistance,
    check_hollenbach_permissible,
)

try:
    import orjson
except Exception:
    orjson = None


# ──────────────────────────────────────────────────────────────────
# Tuning constants
# ──────────────────────────────────────────────────────────────────
MAX_BODY_BYTES      = 64 * 1024
MAX_RETURN_POINTS   = 2_000
RESPONSE_CACHE_SIZE = 64

_RESPONSE_CACHE      = OrderedDict()
_RESPONSE_CACHE_LOCK = threading.RLock()


# ──────────────────────────────────────────────────────────────────
# JSON helpers (identical pattern to turning)
# ──────────────────────────────────────────────────────────────────
def _json_dumps(obj):
    if orjson is not None:
        return orjson.dumps(obj)
    return json.dumps(
        obj,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


# ──────────────────────────────────────────────────────────────────
# Cache helpers
# ──────────────────────────────────────────────────────────────────
def _cache_get(key):
    with _RESPONSE_CACHE_LOCK:
        entry = _RESPONSE_CACHE.get(key)
        if entry is not None:
            _RESPONSE_CACHE.move_to_end(key)
        return entry


def _cache_set(key, raw_bytes):
    with _RESPONSE_CACHE_LOCK:
        _RESPONSE_CACHE[key] = {"raw": raw_bytes, "gzip": None}
        _RESPONSE_CACHE.move_to_end(key)
        while len(_RESPONSE_CACHE) > RESPONSE_CACHE_SIZE:
            _RESPONSE_CACHE.popitem(last=False)
        return _RESPONSE_CACHE[key]


# ──────────────────────────────────────────────────────────────────
# Response helpers
# ──────────────────────────────────────────────────────────────────
def _client_accepts_gzip(request):
    return "gzip" in request.META.get("HTTP_ACCEPT_ENCODING", "").lower()


def _response_from_entry(entry, request, status=200):
    raw = entry["raw"]
    use_gzip = _client_accepts_gzip(request) and len(raw) > 2048

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


# ──────────────────────────────────────────────────────────────────
# Parsing helpers
# ──────────────────────────────────────────────────────────────────
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


def _parse_payload(data):
    """Parse and validate the JSON body, return a clean dict."""
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object.")

    required_keys = ['LPP', 'LWL', 'LOS', 'B', 'T', 'V', 'AVS', 'dTH', 'D', 'Vl', 'Vh']
    for k in required_keys:
        _as_float(data, k, required=True)

    Vl = _as_float(data, 'Vl', required=True)
    Vh = _as_float(data, 'Vh', required=True)
    if Vl >= Vh:
        raise ValueError("Vl must be less than Vh.")
    if Vh > 60.0:
        raise ValueError("Vh is too large (max 60 knots).")

    T = _as_float(data, 'T', required=True)

    ship_data = {}
    for k in required_keys:
        ship_data[k] = _as_float(data, k, required=True)

    ship_data['Ta']  = _as_float(data, 'Ta',  default=T)
    ship_data['Tf']  = _as_float(data, 'Tf',  default=T)
    ship_data['CDA'] = _as_float(data, 'CDA', default=0.8)

    # Legacy scalar appendage
    ship_data['SAPP'] = _as_float(data, 'SAPP', default=0.0)
    ship_data['k2i']  = _as_float(data, 'k2i',  default=0.4)

    # Individual appendages
    appendage_names = [
        'behind_skeg', 'behind_stern', 'twin', 'keel', 'shaft',
        'strut', 'bracket', 'fin', 'dome', 'hull',
    ]
    for name in appendage_names:
        ship_data[name]             = _as_float(data, name,             default=0.0)
        ship_data[name + '_area']   = _as_float(data, name + '_area',   default=0.0)

    response_format = str(data.get('response_format', 'json')).lower().strip()
    if response_format not in ('json', 'compact'):
        response_format = 'json'

    return ship_data, response_format


def _encode_f32_base64(arr):
    a = np.asarray(arr, dtype="<f4")
    return base64.b64encode(a.tobytes()).decode("ascii")


def _format_results(results, response_format):
    """Optionally convert lists to base64-encoded float32 arrays."""
    if response_format != 'compact':
        return results

    compact = {}
    array_keys = [
        'speeds_knots', 'speeds_ms',
        'RT_mean_N', 'RT_min_N', 'RT_mean_kN', 'RT_min_kN',
        'R_friction_mean_N', 'R_wave_mean_N',
        'R_appendage_mean_N', 'R_appendage_min_N',
    ]

    for key in array_keys:
        if key in results:
            compact[key] = _encode_f32_base64(results[key])

    # Scalar fields pass through
    for key in ('CB', 'Wetted_Surface_Sd', 'appendage_area', 'k2_effective'):
        if key in results:
            compact[key] = results[key]

    compact['_format'] = 'f32-base64-v1'
    compact['_length'] = len(results.get('speeds_knots', []))
    return compact


# ──────────────────────────────────────────────────────────────────
# View
# ──────────────────────────────────────────────────────────────────
@method_decorator(csrf_exempt, name="dispatch")
class HollenbachSimulationView(View):
    """
    POST /hollenbach/    → JSON resistance results (cached, gzipped)
    GET  /hollenbach/    → render the HTML page

    Response envelope:
    {
      "success": true,
      "data": {
        "inputs": {...},
        "results": {...},
        "warnings": [...]
      },
      "message": "..."
    }
    """

    http_method_names = ["get", "post", "options"]

    def options(self, request, *args, **kwargs):
        resp = HttpResponse(status=204)
        resp["Allow"] = "GET, POST, OPTIONS"
        return resp

    def get(self, request, *args, **kwargs):
        return render(request, "resistance/hollenbach.html")

    def post(self, request, *args, **kwargs):
        raw_body = request.body or b"{}"

        if len(raw_body) > MAX_BODY_BYTES:
            return _json_error("Request body is too large.", status=413)

        # ── Cache lookup ──────────────────────────────────────────
        cache_key = hashlib.blake2b(raw_body, digest_size=16).hexdigest()
        cached = _cache_get(cache_key)
        if cached is not None:
            return _response_from_entry(cached, request, status=200)

        # ── Parse ─────────────────────────────────────────────────
        try:
            data = json.loads(raw_body)
        except Exception:
            return _json_error("Invalid JSON body.", status=400)

        try:
            ship_data, response_format = _parse_payload(data)
        except ValueError as exc:
            return _json_error(str(exc), status=400)

        # ── Warnings ──────────────────────────────────────────────
        warnings = check_hollenbach_permissible(ship_data)

        # ── Calculate ─────────────────────────────────────────────
        try:
            results = calculate_hollenbach_resistance(ship_data)
            formatted = _format_results(results, response_format)

            output = {
                "success": True,
                "data": {
                    "inputs":   {k: v for k, v in ship_data.items()},
                    "results":  formatted,
                    "warnings": warnings,
                },
                "message": "Hollenbach resistance calculated successfully.",
            }

            raw_response = _json_dumps(output)
            entry = _cache_set(cache_key, raw_response)

            return _response_from_entry(entry, request, status=200)

        except Exception as exc:
            return _json_error(
                message=f"Calculation processing fault: {str(exc)}",
                status=500,
            )