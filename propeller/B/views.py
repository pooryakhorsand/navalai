# maneuver/B/views.py
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

from .engine import WageningenBSeriesModel

try:
    import orjson
except Exception:
    orjson = None


MAX_BODY_BYTES = 32 * 1024
MAX_J_STEPS = 2_000
MAX_CURVES = 64
MAX_TOTAL_POINTS = 200_000
RESPONSE_CACHE_SIZE = 32

_RESPONSE_CACHE = OrderedDict()
_RESPONSE_CACHE_LOCK = threading.RLock()


def _json_dumps(obj):
    if orjson is not None:
        return orjson.dumps(obj, option=orjson.OPT_SERIALIZE_NUMPY)
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
    return "gzip" in request.META.get("HTTP_ACCEPT_ENCODING", "").lower()


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


def _as_float(data, key, default=None, required=False,
              min_value=None, max_value=None):
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

    if min_value is not None and f < min_value:
        raise ValueError(f"Field {key} below minimum ({min_value}).")
    if max_value is not None and f > max_value:
        raise ValueError(f"Field {key} above maximum ({max_value}).")

    return f


def _as_int(data, key, default, min_value, max_value):
    if key not in data:
        return default
    try:
        v = int(float(data[key]))
    except Exception:
        raise ValueError(f"Invalid integer field: {key}")
    if v < min_value:
        v = min_value
    elif v > max_value:
        v = max_value
    return v


def _parse_payload(data):
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object.")

    Z = _as_int(data, "Z", default=4, min_value=2, max_value=7)

    EAR = _as_float(data, "EAR", required=True, min_value=0.30, max_value=1.05)

    PD_min = _as_float(data, "PD_min", default=0.50, min_value=0.50, max_value=1.40)
    PD_max = _as_float(data, "PD_max", default=1.40, min_value=0.50, max_value=1.40)

    if PD_max < PD_min:
        raise ValueError("PD_max must be >= PD_min.")

    Re = _as_float(data, "Re", default=2_000_000.0,
                   min_value=2_000_000.0, max_value=9_000_000.0)

    J_steps = _as_int(data, "J_steps", default=51, min_value=2, max_value=MAX_J_STEPS)

    PD_step = _as_float(data, "PD_step", default=0.15, min_value=0.01, max_value=1.0)

    n_curves = int(math.floor((PD_max - PD_min) / PD_step + 1e-9)) + 1
    if n_curves > MAX_CURVES:
        raise ValueError(
            f"Too many P/D curves: {n_curves}. Increase PD_step or narrow range. "
            f"Maximum allowed: {MAX_CURVES}."
        )

    if n_curves * J_steps > MAX_TOTAL_POINTS:
        raise ValueError(
            f"Too many evaluation points ({n_curves * J_steps}). "
            f"Maximum allowed: {MAX_TOTAL_POINTS}."
        )

    response_format = str(data.get("response_format", "json")).lower().strip()
    if response_format not in ("json", "compact"):
        response_format = "json"

    return {
        "Z": Z, "EAR": EAR, "PD_min": PD_min, "PD_max": PD_max,
        "Re": Re, "J_steps": J_steps, "PD_step": PD_step,
        "response_format": response_format,
    }


def _encode_f32_base64(arr):
    a = np.asarray(arr, dtype="<f4")
    return base64.b64encode(a.tobytes()).decode("ascii")


def _build_curves_payload(result, response_format):
    pd_values = result["pd_values"]
    J_array = result["J_array"]
    Kt = result["Kt"]
    Kq = result["Kq"]
    Kq10 = result["Kq10"]
    eta = result["eta"]

    curves = []

    if response_format == "compact":
        # shared J axis + per-curve base64 float32 payloads
        base = {
            "_format": "f32-base64-v1",
            "_j_length": int(J_array.shape[0]),
            "J": _encode_f32_base64(J_array),
        }
        for ip in range(pd_values.shape[0]):
            curves.append({
                "PoD": float(pd_values[ip]),
                "Kt": _encode_f32_base64(Kt[ip]),
                "Kq": _encode_f32_base64(Kq[ip]),
                "Kq10": _encode_f32_base64(Kq10[ip]),
                "eta": _encode_f32_base64(eta[ip]),
            })
        base["curves"] = curves
        return base

    J_list = np.round(J_array, 6).tolist()
    for ip in range(pd_values.shape[0]):
        curves.append({
            "PoD": float(pd_values[ip]),
            "J": J_list,
            "Kt": np.round(Kt[ip], 6).tolist(),
            "Kq": np.round(Kq[ip], 6).tolist(),
            "Kq10": np.round(Kq10[ip], 6).tolist(),
            "eta": np.round(eta[ip], 6).tolist(),
        })
    return {"curves": curves}


@method_decorator(csrf_exempt, name="dispatch")
class WageningenBSeriesView(View):
    """
    Optimized Wageningen B-Series open-water solver endpoint.

    POST /maneuver/B/

    Response envelope:
    {
      "success": true,
      "data": {"curves": [...], "optimum": {...}},
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
            model = WageningenBSeriesModel(
                Z=parsed["Z"],
                EAR=parsed["EAR"],
                PD_min=parsed["PD_min"],
                PD_max=parsed["PD_max"],
                Re=parsed["Re"],
                J_steps=parsed["J_steps"],
                PD_step=parsed["PD_step"],
            )
            result = model.sweep()

            curves_payload = _build_curves_payload(result, parsed["response_format"])

            data_block = {"optimum": result["optimum"]}
            data_block.update(curves_payload)

            output_payload = {
                "success": True,
                "data": data_block,
                "message": "Wageningen B-Series open-water sweep completed successfully.",
            }

            raw_response = _json_dumps(output_payload)
            entry = _cache_set_raw(cache_key, raw_response)
            return _response_from_entry(entry, request, status=200)

        except Exception as exc:
            return _json_error(
                message=f"Propeller solver fault: {str(exc)}",
                status=500,
            )